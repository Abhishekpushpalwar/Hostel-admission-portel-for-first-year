import { z } from 'zod';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Lets async route functions throw errors into Express's error handler.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const idParam = z.coerce.number().int().positive();

// `db` can be the pool or a transaction client.
export async function audit(db, actorId, action, entity, entityId, details = {}) {
  await db.query(
    'insert into audit_log (actor_id, action, entity, entity_id, details) values ($1, $2, $3, $4, $5)',
    [actorId, action, entity, String(entityId), details]
  );
}

export async function notify(db, userId, title, body) {
  await db.query('insert into notifications (user_id, title, body) values ($1, $2, $3)', [userId, title, body]);
}
