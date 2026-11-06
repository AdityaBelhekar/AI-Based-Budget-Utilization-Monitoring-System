import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import { hashPassword, passwordSchema, requireRole } from './auth.js';
import { HttpError, canSeeDepartment, isHead, objectId } from './http.js';
import { Department, ROLES, User } from './models.js';

const roleFields = { role: z.enum(Object.values(ROLES)), departmentId: objectId.nullable() };

const userCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().email(),
    password: passwordSchema,
    role: roleFields.role,
    departmentId: roleFields.departmentId.default(null),
  })
  .strict();
const userPatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    password: passwordSchema,
    role: roleFields.role,
    departmentId: roleFields.departmentId,
    active: z.boolean(),
  })
  .partial()
  .strict();
const departmentCreate = z
  .object({
    name: z.string().trim().min(1).max(160),
    code: z.string().trim().min(2).max(20),
    sourceNote: z.string().max(500).default(''),
  })
  .strict();
const departmentPatch = z
  .object({ name: z.string().trim().min(1).max(160), sourceNote: z.string().max(500), active: z.boolean() })
  .partial()
  .strict();

// Only Department Heads belong to a department; anyone else's mapping is cleared.
async function resolveDepartment(role, departmentId) {
  if (role !== ROLES.HEAD) return null;
  if (!departmentId) throw new HttpError(400, 'A Department Head must have a department');
  if (!(await Department.exists({ _id: departmentId, active: true }))) throw new HttpError(400, 'Unknown department');
  return departmentId;
}

export function userRoutes() {
  const router = Router();
  router.use(requireRole(ROLES.ADMIN));

  router.get('/', async (_req, res) => res.json(await User.find().sort('name')));

  router.post('/', async (req, res) => {
    const { password, ...body } = userCreate.parse(req.body);
    body.departmentId = await resolveDepartment(body.role, body.departmentId);
    const passwordHash = await hashPassword(password);
    const user = await mongoose.connection.transaction(async (session) => {
      const [created] = await User.create([{ ...body, passwordHash }], { session });
      await writeAudit(session, req.user, { action: 'create', entity: 'user', entityId: created._id, after: created.toJSON() });
      return created;
    });
    res.status(201).json(user);
  });

  router.patch('/:id', async (req, res) => {
    const id = objectId.parse(req.params.id);
    const { password, ...changes } = userPatch.parse(req.body);
    const user = await User.findById(id);
    if (!user) throw new HttpError(404, 'Not found');
    // Blocking self-demotion means at least one working Admin always remains.
    if (user.id === req.user.id && (changes.active === false || (changes.role && changes.role !== ROLES.ADMIN))) {
      throw new HttpError(400, 'You cannot remove your own admin access');
    }
    const before = user.toJSON();
    user.set(changes);
    user.departmentId = await resolveDepartment(user.role, user.departmentId);
    if (password) user.passwordHash = await hashPassword(password);
    await mongoose.connection.transaction(async (session) => {
      await user.save({ session });
      await writeAudit(session, req.user, {
        action: 'update',
        entity: 'user',
        entityId: user._id,
        before,
        // The hash itself is never logged, only the fact that it changed.
        after: { ...user.toJSON(), passwordChanged: Boolean(password) },
      });
    });
    res.json(user);
  });

  return router;
}

export function departmentRoutes() {
  const router = Router();

  router.get('/', async (req, res) => {
    const filter = isHead(req.user) ? { _id: req.user.departmentId } : {};
    res.json(await Department.find(filter).sort('name'));
  });

  router.get('/:id', async (req, res) => {
    const id = objectId.parse(req.params.id);
    const department = canSeeDepartment(req.user, id.toLowerCase()) ? await Department.findById(id) : null;
    if (!department) throw new HttpError(404, 'Not found');
    res.json(department);
  });

  router.post('/', requireRole(ROLES.ADMIN), async (req, res) => {
    const body = departmentCreate.parse(req.body);
    const department = await mongoose.connection.transaction(async (session) => {
      const [created] = await Department.create([body], { session });
      await writeAudit(session, req.user, { action: 'create', entity: 'department', entityId: created._id, after: created.toJSON() });
      return created;
    });
    res.status(201).json(department);
  });

  // No delete route: departments with history are deactivated instead.
  router.patch('/:id', requireRole(ROLES.ADMIN), async (req, res) => {
    const department = await Department.findById(objectId.parse(req.params.id));
    if (!department) throw new HttpError(404, 'Not found');
    const before = department.toJSON();
    department.set(departmentPatch.parse(req.body));
    await mongoose.connection.transaction(async (session) => {
      await department.save({ session });
      await writeAudit(session, req.user, { action: 'update', entity: 'department', entityId: department._id, before, after: department.toJSON() });
    });
    res.json(department);
  });

  return router;
}
