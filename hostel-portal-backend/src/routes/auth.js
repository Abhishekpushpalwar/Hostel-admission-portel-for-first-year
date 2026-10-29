import { Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { config } from '../config.js';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, wrap } from '../utils.js';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { requireRole } from '../middleware/auth.js';

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
      token: z.string().regex(/^\d{6,10}$/)
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
router.post(
  '/auth/admin-login',
  wrap(async (req, res) => {
    const { email, password } = z.object({
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(1).max(200)
    }).parse(req.body);

    const { rows } = await query(
      `SELECT id, email, role, password_hash
         FROM users
        WHERE lower(email) = $1
          AND role::text IN ('admin', 'verifier')
        LIMIT 1`,
      [email]
    );

    const user = rows[0];
    const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!ok) {
      throw new HttpError(401, 'Invalid email or password');
    }

    const jwtToken = jwt.sign(
      { role: user.role },
      config.jwtSecret,
      { subject: String(user.id), expiresIn: '8h' }
    );

    res.json({ token: jwtToken, role: user.role });
  })
);
const adminSupabase = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
);

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

// POST /auth/register  (public, creates an unverified student)
router.post(
  '/auth/register',
  registerLimiter,
  wrap(async (req, res) => {
    const b = z.object({
      capId: z.string().trim().min(1).max(100),
      fullName: z.string().trim().min(1).max(200),
      email: z.string().trim().toLowerCase().email().max(200),
      rollNo: z.string().trim().min(1).max(50).optional(),
      branch: z.string().trim().min(1).max(100),
      category: z.string().trim().min(1).max(50),
      distanceKm: z.coerce.number().int().min(0).max(5000),
      cgpa: z.coerce.number().min(0).max(10).optional(),
      cetPercentile: z.coerce.number().min(0).max(100).optional()
    }).parse(req.body);

    // Students log in with OTP, so the password hash is a random unusable value.
    const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const rollNo = b.rollNo ?? `PENDING-${b.capId}`;

    try {
      // One statement, so either both rows are created or neither.
      await query(
        `WITH u AS (
           INSERT INTO users (id, email, password_hash, role)
           VALUES (gen_random_uuid(), $1, $2, 'student')
           RETURNING id
         )
         INSERT INTO students
           (user_id, roll_no, full_name, branch, category, cgpa,
            cet_percentile, distance_km, cap_id, admin_verified)
         SELECT id, $3, $4, $5, $6, $7, $8, $9, $10, FALSE FROM u`,
        [b.email, unusableHash, rollNo, b.fullName, b.branch, b.category,
         b.cgpa ?? null, b.cetPercentile ?? null, b.distanceKm, b.capId]
      );
    } catch (err) {
      if (err.code === '23505') {
        throw new HttpError(409, 'This CAP ID, email or roll number is already registered');
      }
      throw err;
    }

    res.status(201).json({
      message: 'Registration received. You can log in after the admin verifies your details.'
    });
  })
);

// GET /admin/students?status=pending|verified
router.get(
  '/admin/students',
  requireAuth,
  requireRole('verifier', 'admin'),
  wrap(async (req, res) => {
    const verified = req.query.status === 'verified';
    const { rows } = await query(
      `SELECT s.user_id, s.cap_id, s.full_name, s.roll_no, s.branch, s.category,
              s.cgpa, s.cet_percentile, s.distance_km, u.email, s.admin_verified
         FROM students s
         JOIN users u ON u.id = s.user_id
        WHERE s.admin_verified = $1
        ORDER BY s.full_name`,
      [verified]
    );
    res.json(rows);
  })
);

// POST /admin/students/:id/approve   (:id is the student's user_id)
router.post(
  '/admin/students/:id/approve',
  requireAuth,
  requireRole('verifier', 'admin'),
  wrap(async (req, res) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const { rows } = await query(
      `SELECT u.email
         FROM students s
         JOIN users u ON u.id = s.user_id
        WHERE s.user_id = $1`,
      [id]
    );
    if (!rows[0]) throw new HttpError(404, 'Student not found');

    // Create the Supabase Auth account so OTP login can work.
    const { error } = await adminSupabase.auth.admin.createUser({
      email: rows[0].email,
      email_confirm: true
    });
    if (error && !/already.*(registered|exists)/i.test(error.message)) {
      console.error('Supabase createUser failed:', error.message);
      throw new HttpError(502, 'Could not enable login for this student');
    }

    await query(
      `UPDATE students SET admin_verified = TRUE WHERE user_id = $1`,
      [id]
    );

    res.json({ message: 'Student approved', userId: id });
  })
);

export default router;