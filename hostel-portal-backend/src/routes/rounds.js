import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError, wrap, idParam, audit } from '../utils.js';

const router = Router();
const admin = [requireAuth, requireRole('admin')];

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    ['text/csv', 'text/plain', 'application/vnd.ms-excel'].includes(file.mimetype)
      ? cb(null, true) : cb(new HttpError(400, 'Upload a .csv file')),
});

async function getRound(id) {
  const round = (await query(
    'select id, round_no, status from allotment_rounds where id = $1 and academic_year = $2',
    [id, config.academicYear]
  )).rows[0];
  if (!round) throw new HttpError(404, 'Round not found');
  return round;
}

// POST /admin/rounds   body: { round_no, rank_version }   (rank list must be frozen first)
router.post('/admin/rounds', ...admin, wrap(async (req, res) => {
  const { round_no, rank_version } = z.object({
    round_no: z.number().int().positive(), rank_version: z.number().int().positive(),
  }).parse(req.body);

  const ver = (await query(
    'select id, frozen_at from rank_list_versions where academic_year = $1 and version = $2',
    [config.academicYear, rank_version]
  )).rows[0];
  if (!ver) throw new HttpError(404, 'Rank list version not found');
  if (!ver.frozen_at) throw new HttpError(400, 'Freeze the rank list before creating a round');

  const { rows } = await query(
    `insert into allotment_rounds (academic_year, round_no, rank_version_id, status)
     values ($1, $2, $3, 'draft') returning id, round_no, status`,
    [config.academicYear, round_no, ver.id]
  );
  await audit({ query }, req.user.id, 'create_round', 'round', rows[0].id, { round_no, rank_version });
  res.status(201).json(rows[0]);
}));

// POST /admin/rounds/:id/status   body: { status: "open" | "closed" }
router.post('/admin/rounds/:id/status', ...admin, wrap(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const { status } = z.object({ status: z.enum(['open', 'closed']) }).parse(req.body);
  const stampCol = status === 'open' ? 'opened_at' : 'closed_at'; // fixed list, safe in SQL

  const { rows } = await query(
    `update allotment_rounds set status = $2, ${stampCol} = now()
      where id = $1 and academic_year = $3 and status <> 'published' returning id, round_no, status`,
    [id, status, config.academicYear]
  );
  if (!rows[0]) throw new HttpError(404, 'Round not found or already published');
  await audit({ query }, req.user.id, `round_${status}`, 'round', id);
  res.json(rows[0]);
}));

// POST /admin/rounds/:id/eligibility   csv file in field "file": one roll number per line
// Only roll numbers of VERIFIED students are accepted; the rest are returned as rejected.
router.post('/admin/rounds/:id/eligibility', ...admin, csvUpload.single('file'), wrap(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const round = await getRound(id);
  if (round.status === 'published') throw new HttpError(400, 'Round already published');
  if (!req.file) throw new HttpError(400, 'Attach a CSV file in the "file" field');

  const rolls = [...new Set(
    req.file.buffer.toString('utf8').split(/[\r\n,;]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s && s !== 'ROLL_NO' && s !== 'ROLL NO')
  )];
  if (!rolls.length) throw new HttpError(400, 'The file has no roll numbers');
  if (rolls.length > 5000) throw new HttpError(400, 'Too many rows');

  const out = await tx(async (db) => {
    const matched = (await db.query(
      `select s.user_id, upper(s.roll_no) as roll_no
         from students s join v_application_status v
           on v.student_id = s.user_id and v.academic_year = $2 and v.status = 'verified'
        where upper(s.roll_no) = any($1::text[])`,
      [rolls, config.academicYear]
    )).rows;

    await db.query('delete from eligibility where round_id = $1', [id]);
    if (matched.length) {
      await db.query(
        'insert into eligibility (round_id, student_id) select $1::int, unnest($2::uuid[])',
        [id, matched.map((m) => m.user_id)]
      );
    }
    const ok = new Set(matched.map((m) => m.roll_no));
    const rejected = rolls.filter((r) => !ok.has(r));
    await audit(db, req.user.id, 'upload_eligibility', 'round', id, { added: matched.length, rejected: rejected.length });
    return { added: matched.length, rejected };
  });
  res.json(out);
}));

const RESULTS_SQL = `
  select a.rank_used as rank, rm.room_no, a.choice_no as preference_granted,
         (select json_agg(json_build_object('roll_no', s.roll_no, 'name', s.full_name) order by s.roll_no)
            from group_members m join students s on s.user_id = m.student_id
           where m.group_id = a.group_id and m.state = 'accepted') as members
    from allotments a join rooms rm on rm.id = a.room_id
   where a.round_id = $1 order by a.rank_used, rm.room_no`;

// POST /admin/rounds/:id/run   (round must be closed). Safe to repeat: same input, same output.
router.post('/admin/rounds/:id/run', ...admin, wrap(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const round = await getRound(id);
  if (round.status !== 'closed') throw new HttpError(400, `Close the round before running the allocation (it is ${round.status})`);

  const { n } = (await query('select allocate_round($1) as n', [id])).rows[0]; // the SQL function does the work
  await audit({ query }, req.user.id, 'run_allocation', 'round', id, { groups_allotted: n });

  const results = (await query(RESULTS_SQL, [id])).rows;
  const unallocated = (await query(
    `select vg.group_id, vg.group_rank from v_ready_groups vg
      where vg.round_id = $1
        and not exists (select 1 from allotments a where a.group_id = vg.group_id and a.round_id = $1)
      order by vg.group_rank`,
    [id]
  )).rows;
  res.json({ groups_allotted: n, results, unallocated_groups: unallocated });
}));

// POST /admin/rounds/:id/publish   makes results public and notifies students
router.post('/admin/rounds/:id/publish', ...admin, wrap(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const round = await getRound(id);
  if (round.status === 'published') throw new HttpError(409, 'Already published');
  if (round.status !== 'closed') throw new HttpError(400, 'Close the round and run the allocation first');

  await tx(async (db) => {
    const count = (await db.query('select count(*)::int as n from allotments where round_id = $1', [id])).rows[0].n;
    if (!count) throw new HttpError(400, 'Run the allocation before publishing');

    await db.query(`update allotment_rounds set status = 'published', published_at = now() where id = $1`, [id]);

    // Tell every member of an allotted group which room they got ...
    await db.query(
      `insert into notifications (user_id, title, body)
       select m.student_id, 'Allotment result published', 'Your group has been allotted room ' || rm.room_no
         from allotments a
         join group_members m on m.group_id = a.group_id and m.state = 'accepted'
         join rooms rm on rm.id = a.room_id
        where a.round_id = $1`, [id]);
    // ... and tell groups with no room to form again for the next round.
    await db.query(
      `insert into notifications (user_id, title, body)
       select m.student_id, 'Allotment result published', 'Your group did not get a room in this round. Please re-form your group for the next round.'
         from groups g
         join group_members m on m.group_id = g.id and m.state = 'accepted'
        where g.round_id = $1
          and not exists (select 1 from allotments a where a.group_id = g.id and a.round_id = $1)`, [id]);

    await audit(db, req.user.id, 'publish_round', 'round', id, { groups_allotted: count });
  });
  res.json({ id, status: 'published' });
}));

export default router;
