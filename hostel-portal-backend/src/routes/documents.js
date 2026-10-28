import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { putFile, signedUrl, scanForVirus } from '../storage.js';
import { HttpError, wrap, idParam, audit, notify } from '../utils.js';

const router = Router();

const DOC_TYPES = ['marksheet_10', 'marksheet_12', 'distance_certificate', 'category_certificate'];
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) =>
    EXT[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Only PDF, JPG or PNG files are allowed')),
});

// Check the first bytes of the file really match what it claims to be.
function looksValid(buf, mime) {
  if (mime === 'application/pdf') return buf.subarray(0, 4).toString() === '%PDF';
  if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/png') return buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return false;
}

// POST /documents   (student)  multipart form: doc_type, file
router.post('/documents', requireAuth, requireRole('student'), upload.single('file'), wrap(async (req, res) => {
  const { doc_type } = z.object({ doc_type: z.enum(DOC_TYPES) }).parse(req.body);
  const file = req.file;
  if (!file) throw new HttpError(400, 'Attach a file in the "file" field');
  if (!looksValid(file.buffer, file.mimetype)) throw new HttpError(400, 'File content does not match its type');
  if (!(await scanForVirus(file.buffer))) throw new HttpError(400, 'File failed the virus scan');

  const studentId = req.user.id;
  const id = await tx(async (db) => {
    // Create this student's application for the year if it does not exist yet.
    const app = (await db.query(
      `insert into applications (student_id, academic_year) values ($1, $2)
       on conflict (student_id, academic_year) do update set student_id = excluded.student_id
       returning id, resubmit_deadline`,
      [studentId, config.academicYear]
    )).rows[0];

    if (app.resubmit_deadline && new Date(app.resubmit_deadline) < new Date()) {
      throw new HttpError(403, 'The resubmission deadline has passed. Ask the admission office to reopen it');
    }

    const existing = (await db.query(
      'select id, status from documents where application_id = $1 and doc_type = $2 order by id desc limit 1',
      [app.id, doc_type]
    )).rows[0];
    if (existing?.status === 'verified') throw new HttpError(409, 'This document is already verified');

    const path = `${studentId}/${doc_type}-${Date.now()}.${EXT[file.mimetype]}`;
    await putFile(path, file.buffer, file.mimetype);

    let docId;
    if (existing) {
      // Re-upload of a pending or flagged document: replace the file, clear the old remark.
      await db.query(
        `update documents set storage_path = $2, status = 'pending', remark = null,
                uploaded_at = now(), reviewed_by = null, reviewed_at = null where id = $1`,
        [existing.id, path]
      );
      docId = existing.id;
    } else {
      docId = (await db.query(
        'insert into documents (application_id, doc_type, storage_path) values ($1, $2, $3) returning id',
        [app.id, doc_type, path]
      )).rows[0].id;
    }
    await audit(db, studentId, 'upload_document', 'document', docId, { doc_type });
    return docId;
  });

  res.status(201).json({ id, doc_type, status: 'pending' });
}));

// GET /documents   (student) - my documents and their status
router.get('/documents', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const { rows } = await query(
    `select d.id, d.doc_type, d.status, d.remark, d.uploaded_at
       from documents d join applications a on a.id = d.application_id
      where a.student_id = $1 and a.academic_year = $2 order by d.id`,
    [req.user.id, config.academicYear]
  );
  res.json(rows);
}));

// GET /documents/:id/link   owner or verifier/admin; link works for 60 seconds, every open is logged
router.get('/documents/:id/link', requireAuth, wrap(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const { rows } = await query(
    `select d.storage_path, a.student_id from documents d join applications a on a.id = d.application_id where d.id = $1`,
    [id]
  );
  const doc = rows[0];
  if (!doc) throw new HttpError(404, 'Document not found');

  const isStaff = ['verifier', 'admin'].includes(req.user.role);
  if (!isStaff && doc.student_id !== req.user.id) throw new HttpError(403, 'This is not your document');

  const url = await signedUrl(doc.storage_path, 60);
  await audit({ query }, req.user.id, 'open_document', 'document', id, { role: req.user.role });
  res.json({ url, expires_in_seconds: 60 });
}));

// POST /admin/documents/:id/approve   (verifier, admin)
// POST /admin/documents/:id/flag      (verifier, admin) body: { remark }  - remark is mandatory
async function review(req, res, status, remark) {
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const r = await db.query(
      `update documents set status = $2, remark = $3, reviewed_by = $4, reviewed_at = now()
        where id = $1 returning application_id, doc_type`,
      [id, status, remark, req.user.id]
    );
    if (!r.rowCount) throw new HttpError(404, 'Document not found');
    const { application_id, doc_type } = r.rows[0];
    const studentId = (await db.query('select student_id from applications where id = $1', [application_id])).rows[0].student_id;

    const approved = status === 'verified';
    await audit(db, req.user.id, approved ? 'approve_document' : 'flag_document', 'document', id, { remark });
    await notify(db, studentId,
      approved ? 'Document verified' : 'Document flagged',
      approved ? `Your ${doc_type} was verified.` : `Your ${doc_type} was flagged: ${remark}`);
  });
  res.json({ id, status });
}

router.post('/admin/documents/:id/approve', requireAuth, requireRole('verifier', 'admin'),
  wrap((req, res) => review(req, res, 'verified', null)));

router.post('/admin/documents/:id/flag', requireAuth, requireRole('verifier', 'admin'),
  wrap((req, res) => {
    const { remark } = z.object({ remark: z.string().trim().min(1, 'A remark is required').max(500) }).parse(req.body);
    return review(req, res, 'flagged', remark);
  }));

export default router;
