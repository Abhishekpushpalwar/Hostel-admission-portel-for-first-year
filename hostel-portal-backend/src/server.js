import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { pool } from './db.js';
import { notFound, errorHandler } from './middleware/errors.js';
import { wrap } from './utils.js';
import auth from './routes/auth.js';
import documents from './routes/documents.js';
import ranklist from './routes/ranklist.js';
import rounds from './routes/rounds.js';
import groups from './routes/groups.js';
import publicRoutes from './routes/public.js';

const app = express();
app.set('trust proxy', 1); // needed behind Render's proxy so rate limits see the real IP
app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));

app.get('/health', wrap(async (_req, res) => {
  await pool.query('select 1');
  res.json({ ok: true });
}));

for (const router of [auth, documents, ranklist, rounds, groups, publicRoutes]) app.use(router);

app.use(notFound);
app.use(errorHandler);

app.listen(config.port, () => console.log(`API running on port ${config.port}`));
