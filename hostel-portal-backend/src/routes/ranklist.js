import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError, wrap, idParam, audit } from '../utils.js';

const router = Router();

// POST /admin/ranklist   (admin) body: { basis: "cgpa" | "cet_percentile" }
// Ranks all VERIFIED applications, highest score first, ties by roll number (published tie-break).
router.post('/admin/ranklist', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const { basis } = z.object({ basis: z.enum(['cgpa', 'cet_percentile']).default('cgpa') }).parse(req.body ?? {});
  const col = basis === 'cgpa' ? 's.cgpa' : 's.cet_percentile'; // from a fixed list above, safe to put in SQL

  const out = await tx(async (db) => {
    const { v } = (await db.query(
      'select coalesce(max(version), 0) + 1 as v from rank_list_versions where academic_year = $1',
      [config.academicYear]
    )).rows[0];

    const ver = (await db.query(
      'insert into rank_list_versions (academic_year, version, basis, created_by) values ($1, $2, $3, $4) returning id',
      [config.academicYear, v, basis, req.user.id]
    )).rows[0];

    const ins = await db.query(
      `insert into rank_list_entries (version_id, rank, student_id, score)
       select $1::int, row_number() over (order by ${col} desc, s.roll_no), s.user_id, ${col}
         from v_application_status v
         join students s on s.user_id = v.student_id
        where v.academic_year = $2 and v.status = 'verified' and ${col} is not null`,
      [ver.id, config.academicYear]
    );
    if (!ins.rowCount) throw new HttpError(400, 'There are no verified applications to rank');

    await audit(db, req.user.id, 'generate_ranklist', 'rank_list_version', ver.id, { version: v, basis, entries: ins.rowCount });
    return { version: v, basis, entries: ins.rowCount };
  });

  res.status(201).json(out);
}));

// POST /admin/ranklist/:version/freeze   (admin)
// Locks the list for good and stores a hash you can publish so anyone can check it never changed.
router.post('/admin/ranklist/:version/freeze', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const version = idParam.parse(req.params.version);

  const out = await tx(async (db) => {
    const ver = (await db.query(
      'select id, frozen_at from rank_list_versions where academic_year = $1 and version = $2 for update',
      [config.academicYear, version]
    )).rows[0];
    if (!ver) throw new HttpError(404, 'Rank list version not found');
    if (ver.frozen_at) throw new HttpError(409, 'This rank list is already frozen');

    const entries = (await db.query(
      'select rank, student_id from rank_list_entries where version_id = $1 order by rank', [ver.id]
    )).rows;
    const hash = createHash('sha256').update(entries.map((e) => `${e.rank}:${e.student_id}`).join('\n')).digest('hex');

    await db.query('update rank_list_versions set frozen_at = now(), content_hash = $2 where id = $1', [ver.id, hash]);
    await audit(db, req.user.id, 'freeze_ranklist', 'rank_list_version', ver.id, { version, hash });
    return { version, content_hash: hash };
  });

  res.json(out);
}));

// GET /ranklist/:version   (any logged-in user)
router.get('/ranklist/:version', requireAuth, wrap(async (req, res) => {
  const version = idParam.parse(req.params.version);
  const ver = (await query(
    'select id, version, basis, created_at, frozen_at, content_hash from rank_list_versions where academic_year = $1 and version = $2',
    [config.academicYear, version]
  )).rows[0];
  if (!ver) throw new HttpError(404, 'Rank list version not found');

  const { rows } = await query(
    `select e.rank, s.roll_no, s.full_name, s.branch, s.category, e.score
       from rank_list_entries e join students s on s.user_id = e.student_id
      where e.version_id = $1 order by e.rank`,
    [ver.id]
  );
  const { id: _omit, ...meta } = ver;
  res.json({ ...meta, entries: rows });
}));

export default router;
