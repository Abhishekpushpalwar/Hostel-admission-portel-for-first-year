import { Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { config } from '../config.js';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, wrap } from '../utils.js';

const router = Router();

const supabase = createClient(
  config.supabaseUrl,
  config.supabaseAnonKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  }
);

const requestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

// POST /auth/request-otp
router.post(
  '/auth/request-otp',
  requestLimiter,
  wrap(async (req, res) => {
    const { capId } = z.object({
      capId: z.string().trim().min(1).max(100)
    }).parse(req.body);

    const { rows } = await query(
      `SELECT u.email
         FROM students s
         JOIN users u ON u.id = s.user_id
        WHERE s.cap_id = $1
          AND s.admin_verified = TRUE
          AND u.role = 'student'
        LIMIT 1`,
      [capId]
    );

    // Do not reveal whether a CAP ID exists or is verified.
    if (!rows[0]?.email) {
      return res.status(200).json({
        message: 'If the account is eligible, an OTP will be sent to its registered email.'
      });
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: rows[0].email,
      options: {
        shouldCreateUser: false
      }
    });

    if (error) {
      console.error('OTP request failed:', error.message);
      throw new HttpError(502, 'Unable to send OTP. Please try again later.');
    }

    res.json({
      message: 'If the account is eligible, an OTP will be sent to its registered email.'
    });
  })
);

// POST /auth/verify-otp
router.post(
  '/auth/verify-otp',
  verifyLimiter,
  wrap(async (req, res) => {
    const { capId, token } = z.object({
      capId: z.string().trim().min(1).max(100),
      token: z.string().regex(/^\d{6}$/)
    }).parse(req.body);

    const { rows } = await query(
      `SELECT u.id, u.email, u.role
         FROM students s
         JOIN users u ON u.id = s.user_id
        WHERE s.cap_id = $1
          AND s.admin_verified = TRUE
          AND u.role = 'student'
        LIMIT 1`,
      [capId]
    );

    if (!rows[0]?.email) {
      throw new HttpError(401, 'Invalid or expired OTP');
    }

    const user = rows[0];

    const { data, error } = await supabase.auth.verifyOtp({
      email: user.email,
      token,
      type: 'email'
    });

    if (error || !data?.user?.email) {
      throw new HttpError(401, 'Invalid or expired OTP');
    }

    if (
      data.user.email.toLowerCase() !== user.email.toLowerCase()
    ) {
      throw new HttpError(401, 'Invalid or expired OTP');
    }

    const jwtToken = jwt.sign(
      { role: user.role },
      config.jwtSecret,
      {
        subject: String(user.id),
        expiresIn: '8h'
      }
    );

    res.json({
      token: jwtToken,
      role: user.role
    });
  })
);

// GET /me
router.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT u.id, u.email, u.role,
              s.cap_id, s.roll_no, s.full_name, s.branch,
              s.category, s.cgpa, s.distance_km
         FROM users u
         LEFT JOIN students s ON s.user_id = u.id
        WHERE u.id = $1`,
      [req.user.id]
    );

    if (!rows[0]) {
      throw new HttpError(404, 'User not found');
    }

    res.json(rows[0]);
  })
);

export default router;