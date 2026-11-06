import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import { requireRole } from './auth.js';
import { HttpError, canSeeDepartment, fyLabel, isHead, objectId, pageQuery, paginate, safePaise } from './http.js';
import { AuditLog, Budget, Department, ROLES, Transaction } from './models.js';

const quarterSplit = z.array(safePaise.nonnegative()).length(4);
const budgetCreate = z
  .object({
    financialYear: fyLabel,
    departmentId: objectId,
    project: z.string().trim().max(160).default(''),
    allocatedPaise: safePaise.positive(),
    quarterSplit: quarterSplit.optional(),
  })
  .strict();
const budgetPatch = z
  .object({
    allocatedPaise: safePaise.nonnegative().optional(),
    quarterSplit: quarterSplit.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
const budgetQuery = z.object({ ...pageQuery, financialYear: fyLabel.optional(), departmentId: objectId.optional() });

function assertSplit(split, allocatedPaise) {
  if (split && split.reduce((a, b) => a + b, 0) !== allocatedPaise) {
    throw new HttpError(400, 'Quarterly amounts must add up exactly to the annual amount');
  }
}

async function projectTotal(budget, session, excludeId) {
  const projects = await Budget.find({
    financialYear: budget.financialYear,
    departmentId: budget.departmentId,
    project: { $ne: '' },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).session(session);
  return projects.reduce((sum, p) => sum + p.allocatedPaise, 0);
}

// Project allocations must fit inside the department's own budget.
async function assertProjectsFit(budget, session) {
  if (budget.project) {
    const parent = await Budget.findOne({ financialYear: budget.financialYear, departmentId: budget.departmentId, project: '' }).session(session);
    if (!parent) throw new HttpError(400, 'Create the department budget before its project budgets');
    const others = await projectTotal(budget, session, budget._id);
    if (others + budget.allocatedPaise > parent.allocatedPaise) {
      throw new HttpError(400, "Project allocations would exceed the department's budget");
    }
  } else if ((await projectTotal(budget, session)) > budget.allocatedPaise) {
    throw new HttpError(400, 'The department budget cannot be less than its project allocations');
  }
}

async function findScoped(req) {
  const budget = await Budget.findById(objectId.parse(req.params.id));
  if (!budget || !canSeeDepartment(req.user, budget.departmentId)) throw new HttpError(404, 'Not found');
  return budget;
}

export function budgetRoutes() {
  const router = Router();
  const adminOnly = requireRole(ROLES.ADMIN);

  router.get('/', async (req, res) => {
    const { page, limit, ...filter } = budgetQuery.parse(req.query);
    if (isHead(req.user)) filter.departmentId = req.user.departmentId;
    res.json(await paginate(Budget.find(filter).sort('-financialYear departmentId project'), { page, limit }));
  });

  router.get('/:id', async (req, res) => res.json(await findScoped(req)));

  router.get('/:id/history', async (req, res) => {
    const budget = await findScoped(req);
    res.json(await AuditLog.find({ entity: 'budget', entityId: budget._id }).sort('-at').limit(200));
  });

  router.post('/', adminOnly, async (req, res) => {
    const body = budgetCreate.parse(req.body);
    assertSplit(body.quarterSplit, body.allocatedPaise);
    if (!(await Department.exists({ _id: body.departmentId, active: true }))) throw new HttpError(400, 'Unknown department');
    const budget = await mongoose.connection.transaction(async (session) => {
      const [created] = await Budget.create([body], { session });
      await assertProjectsFit(created, session);
      await writeAudit(session, req.user, { action: 'create', entity: 'budget', entityId: created._id, after: created.toJSON() });
      return created;
    });
    res.status(201).json(budget);
  });

  router.patch('/:id', adminOnly, async (req, res) => {
    const { reason, ...changes } = budgetPatch.parse(req.body);
    const budget = await Budget.findById(objectId.parse(req.params.id));
    if (!budget) throw new HttpError(404, 'Not found');
    const before = budget.toJSON();
    budget.set(changes);
    assertSplit(budget.quarterSplit, budget.allocatedPaise);
    await mongoose.connection.transaction(async (session) => {
      await budget.save({ session });
      await assertProjectsFit(budget, session);
      await writeAudit(session, req.user, { action: 'update', entity: 'budget', entityId: budget._id, before, after: budget.toJSON(), reason });
    });
    res.json(budget);
  });

  router.delete('/:id', adminOnly, async (req, res) => {
    const budget = await Budget.findById(objectId.parse(req.params.id));
    if (!budget) throw new HttpError(404, 'Not found');
    if (await Transaction.exists({ budgetId: budget._id })) throw new HttpError(409, 'This budget has spending recorded, so it cannot be deleted');
    if (!budget.project && (await projectTotal(budget))) throw new HttpError(409, 'Delete this budget\'s project budgets first');
    const before = budget.toJSON();
    await mongoose.connection.transaction(async (session) => {
      await Budget.deleteOne({ _id: budget._id }).session(session);
      await writeAudit(session, req.user, { action: 'delete', entity: 'budget', entityId: budget._id, before });
    });
    res.status(204).end();
  });

  return router;
}
