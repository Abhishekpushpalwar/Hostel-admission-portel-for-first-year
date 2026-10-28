import { ZodError } from 'zod';
import { HttpError } from '../utils.js';

export const notFound = (_req, _res, next) => next(new HttpError(404, 'Not found'));

// One place that turns any error into a clean JSON reply.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) return res.status(400).json({ error: 'Invalid input', details: err.issues });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is too large' });

  // PostgreSQL errors
  if (err.code === 'P0001') return res.status(400).json({ error: err.message });       // our trigger/function rules
  if (err.code === '23505') return res.status(409).json({ error: 'This already exists or conflicts with existing data' });
  if (err.code === '23503') return res.status(400).json({ error: 'A related record was not found' });
  if (err.code === '23514') return res.status(400).json({ error: 'A value is not allowed (check the remark or range)' });

  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
}
