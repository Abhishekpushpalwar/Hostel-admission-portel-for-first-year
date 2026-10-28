import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { wrap } from '../utils.js';

const router = Router();

// GET /allotments?round=1   published results: who got which room, with the rank that decided it
router.get('/allotments', requireAuth, wrap(async (req, res) => {
  const round = z.coerce.number().int().positive().nullable().parse(req.query.round ?? null);
  const { rows } = await query(
    `select r.round_no, a.rank_used as rank, rm.room_no, rm.floor, a.choice_no as preference_granted,
       (select json_agg(json_build_object('roll_no', s.roll_no, 'name', s.full_name) order by s.roll_no)
          from group_members m join students s on s.user_id = m.student_id
         where m.group_id = a.group_id and m.state = 'accepted') as members
     from allotments a
     join allotment_rounds r on r.id = a.round_id and r.status = 'published'
     join rooms rm on rm.id = a.room_id
    where a.academic_year = $1 and ($2::int is null or r.round_no = $2::int)
    order by r.round_no, a.rank_used, rm.room_no`,
    [config.academicYear, round]
  );
  res.json(rows);
}));

// GET /rooms/vacant   rooms not allotted in any published round
router.get('/rooms/vacant', requireAuth, wrap(async (_req, res) => {
  const { rows } = await query(
    `select rm.id, h.name as hostel, rm.room_no, rm.floor, rm.capacity, rm.washroom_side, rm.facing, rm.plan_x, rm.plan_y
       from rooms rm join hostels h on h.id = rm.hostel_id
      where rm.is_active
        and not exists (
          select 1 from allotments a join allotment_rounds r on r.id = a.round_id and r.status = 'published'
           where a.room_id = rm.id and a.academic_year = $1)
      order by h.name, rm.floor, rm.room_no`,
    [config.academicYear]
  );
  res.json(rows);
}));

export default router;
