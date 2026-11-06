import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import { requireRole } from './auth.js';
import { ALERT_TYPES, DEFAULT_THRESHOLDS, SEVERITIES, mergeThresholds } from './detection.js';
import { financialYearOf, todayInIndia } from './fy.js';
import { HttpError, canSeeDepartment, fyLabel, isHead, objectId, pageQuery, paginate } from './http.js';
import { Alert, Department, ROLES, Threshold } from './models.js';
import { scan } from './monitor.js';

const alertQuery = z.object({
  ...pageQuery,
  status: z.enum(['open', 'acknowledged', 'resolved', 'active']).optional(),
  severity: z.enum(SEVERITIES).optional(),
  type: z.enum(Object.keys(ALERT_TYPES)).optional(),
  financialYear: fyLabel.optional(),
  departmentId: objectId.optional(),
  budgetId: objectId.optional(),
});
const alertAction = z
  .object({ action: z.enum(['acknowledge', 'resolve']), note: z.string().trim().max(1000).default('') })
  .strict()
  .refine((b) => b.action !== 'resolve' || b.note.length >= 3, { message: 'Resolving needs a note of at least 3 characters', path: ['note'] });

// Every threshold is a non-negative number; the shape mirrors DEFAULT_THRESHOLDS so nothing unknown is stored.
const thresholdValues = z
  .object(
    Object.fromEntries(
      Object.entries(DEFAULT_THRESHOLDS).map(([rule, values]) => [
        rule,
        z.object(Object.fromEntries(Object.keys(values).map((k) => [k, z.number().nonnegative().max(1000)]))).partial().strict().optional(),
      ]),
    ),
  )
  .strict();
const thresholdBody = z.object({ departmentId: objectId.nullable().default(null), values: thresholdValues }).strict();

const currentYear = () => financialYearOf(todayInIndia());
const countByType = (items) => Object.fromEntries(Object.keys(ALERT_TYPES).map((t) => [t, items.filter((i) => i.type === t).length]));

export function alertRoutes() {
  const router = Router();

  router.get('/', async (req, res) => {
    const { page, limit, status, ...filter } = alertQuery.parse(req.query);
    if (status === 'active') filter.status = { $in: ['open', 'acknowledged'] };
    else if (status) filter.status = status;
    if (isHead(req.user)) filter.departmentId = req.user.departmentId;
    const query = Alert.find(filter).sort({ status: -1, severityRank: -1, detectedAt: -1 }).populate('departmentId', 'name code');
    res.json(await paginate(query, { page, limit }));
  });

  router.get('/unread-count', async (req, res) => {
    const filter = { status: 'open', financialYear: currentYear() };
    if (isHead(req.user)) filter.departmentId = req.user.departmentId;
    res.json({ open: await Alert.countDocuments(filter) });
  });

  router.patch('/:id', requireRole(ROLES.FINANCE, ROLES.HEAD), async (req, res) => {
    const { action, note } = alertAction.parse(req.body);
    const alert = await Alert.findById(objectId.parse(req.params.id));
    if (!alert || !canSeeDepartment(req.user, alert.departmentId)) throw new HttpError(404, 'Not found');
    if (alert.status === 'resolved') throw new HttpError(409, 'This alert is already resolved');
    if (action === 'acknowledge' && alert.status !== 'open') throw new HttpError(409, 'This alert is already acknowledged');
    const before = { status: alert.status };
    const now = new Date();
    if (action === 'acknowledge') alert.set({ status: 'acknowledged', acknowledgedAt: now });
    // Resolving straight from open also counts as the first response.
    else alert.set({ status: 'resolved', resolvedAt: now, acknowledgedAt: alert.acknowledgedAt ?? now });
    alert.history.push({ at: now, action: action === 'acknowledge' ? 'acknowledged' : 'resolved', actorName: req.user.name, note });
    await mongoose.connection.transaction(async (session) => {
      await alert.save({ session });
      await writeAudit(session, req.user, { action, entity: 'alert', entityId: alert._id, before, after: { status: alert.status }, reason: note });
    });
    res.json(alert);
  });

  return router;
}

export function thresholdRoutes() {
  const router = Router();
  router.use(requireRole(ROLES.ADMIN));

  router.get('/', async (_req, res) => {
    const docs = await Threshold.find().lean();
    const global = docs.find((d) => !d.departmentId)?.values ?? {};
    res.json({
      defaults: DEFAULT_THRESHOLDS,
      global: mergeThresholds(global),
      overrides: docs.filter((d) => d.departmentId).map((d) => ({ departmentId: d.departmentId, values: d.values })),
    });
  });

  router.put('/', async (req, res) => {
    const { departmentId, values } = thresholdBody.parse(req.body);
    if (departmentId && !(await Department.exists({ _id: departmentId }))) throw new HttpError(400, 'Unknown department');
    const doc = (await Threshold.findOne({ departmentId })) ?? new Threshold({ departmentId });
    const before = structuredClone(doc.values ?? {});
    doc.values = values;
    doc.markModified('values');
    await mongoose.connection.transaction(async (session) => {
      await doc.save({ session });
      await writeAudit(session, req.user, {
        action: 'update',
        entity: 'threshold',
        entityId: doc._id,
        before,
        after: values,
        reason: departmentId ? 'Department override' : 'Global thresholds',
      });
    });
    // A change applies to future scans only; existing alerts keep the evidence they fired with.
    res.json(doc);
  });

  // Shows what a change would do before it is saved.
  router.post('/preview', async (req, res) => {
    const { departmentId, values } = thresholdBody.parse(req.body);
    const filter = { financialYear: currentYear(), ...(departmentId ? { departmentId } : {}) };
    const [now, proposed] = await Promise.all([
      scan({ filter, persist: false }),
      scan({ filter, persist: false, override: { departmentId, values } }),
    ]);
    res.json({ financialYear: filter.financialYear, current: countByType(now.findings), proposed: countByType(proposed.findings) });
  });

  return router;
}

export function scanRoutes() {
  const router = Router();
  router.post('/run', requireRole(ROLES.ADMIN), async (req, res) => {
    const result = await scan();
    await writeAudit(null, req.user, {
      action: 'scan',
      entity: 'scan',
      entityId: new mongoose.Types.ObjectId(),
      after: { budgetsChecked: result.budgetsChecked, findings: result.findings.length, raised: result.raised, escalated: result.escalated },
    });
    res.json({ budgetsChecked: result.budgetsChecked, findings: result.findings.length, raised: result.raised, escalated: result.escalated });
  });
  return router;
}

// Vercel Cron calls this once a day with the CRON_SECRET it was configured with.
export function cronRoute(secret) {
  return async (req, res) => {
    const expected = Buffer.from(`Bearer ${secret ?? ''}`);
    const given = Buffer.from(req.get('authorization') ?? '');
    if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return res.status(401).json({ error: 'Not permitted' });
    }
    const result = await scan();
    res.json({ budgetsChecked: result.budgetsChecked, raised: result.raised, escalated: result.escalated });
  };
}
