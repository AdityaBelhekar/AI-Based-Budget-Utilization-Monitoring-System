import { existsSync } from 'node:fs';
import path from 'node:path';
import MongoStore from 'connect-mongo';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { departmentRoutes, userRoutes } from './admin.js';
import { auditRoutes } from './audit.js';
import { authRoutes, requireAuth } from './auth.js';
import { budgetRoutes } from './budgets.js';
import { financialYearPosition } from './fy.js';
import { documentRoutes, transactionRoutes } from './transactions.js';

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

export function createApp({ sessionSecret, production = false, clientDir }) {
  const app = express();
  // Render terminates TLS in front of the app; needed for secure cookies and per-client rate limits.
  if (production) app.set('trust proxy', 1);

  app.use(helmet());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    const up = mongoose.connection.readyState === 1;
    res.status(up ? 200 : 503).json({ status: up ? 'ok' : 'database unavailable' });
  });

  app.use(
    '/api',
    session({
      name: 'sid',
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      store: MongoStore.create({ client: mongoose.connection.getClient() }),
      cookie: { httpOnly: true, sameSite: 'strict', secure: production, maxAge: EIGHT_HOURS_MS },
    }),
  );

  app.use('/api/auth', authRoutes());
  app.use('/api/users', requireAuth, userRoutes());
  app.use('/api/departments', requireAuth, departmentRoutes());
  app.use('/api/budgets', requireAuth, budgetRoutes());
  app.use('/api/transactions', requireAuth, transactionRoutes());
  app.use('/api/documents', requireAuth, documentRoutes());
  app.use('/api/audit-logs', requireAuth, auditRoutes());
  app.get('/api/dashboard/summary', requireAuth, (_req, res) => res.json(financialYearPosition()));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  if (clientDir && existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get('/{*page}', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Invalid input', issues: err.issues });
    if (err.code === 11000) return res.status(409).json({ error: 'That value is already in use' });
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Files can be at most 5 MB' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, ...err.details });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
