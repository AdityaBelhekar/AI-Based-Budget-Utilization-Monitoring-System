import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, passwordSchema, requireRole } from './auth.js';
import { Department, ROLES, User } from './models.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
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

class BadRequest extends Error {
  status = 400;
}

// Only Department Heads belong to a department; anyone else's mapping is cleared.
async function resolveDepartment(role, departmentId) {
  if (role !== ROLES.HEAD) return null;
  if (!departmentId) throw new BadRequest('A Department Head must have a department');
  if (!(await Department.exists({ _id: departmentId, active: true }))) throw new BadRequest('Unknown department');
  return departmentId;
}

export function userRoutes() {
  const router = Router();
  router.use(requireRole(ROLES.ADMIN));

  router.get('/', async (_req, res) => res.json(await User.find().sort('name')));

  router.post('/', async (req, res) => {
    const { password, ...body } = userCreate.parse(req.body);
    body.departmentId = await resolveDepartment(body.role, body.departmentId);
    const user = await User.create({ ...body, passwordHash: await hashPassword(password) });
    res.status(201).json(user);
  });

  router.patch('/:id', async (req, res) => {
    const id = objectId.parse(req.params.id);
    const { password, ...changes } = userPatch.parse(req.body);
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    // Blocking self-demotion means at least one working Admin always remains.
    if (user.id === req.user.id && (changes.active === false || (changes.role && changes.role !== ROLES.ADMIN))) {
      throw new BadRequest('You cannot remove your own admin access');
    }
    user.set(changes);
    user.departmentId = await resolveDepartment(user.role, user.departmentId);
    if (password) user.passwordHash = await hashPassword(password);
    await user.save();
    res.json(user);
  });

  return router;
}

export function departmentRoutes() {
  const router = Router();
  const isHead = (req) => req.user.role === ROLES.HEAD;

  router.get('/', async (req, res) => {
    const filter = isHead(req) ? { _id: req.user.departmentId } : {};
    res.json(await Department.find(filter).sort('name'));
  });

  router.get('/:id', async (req, res) => {
    const id = objectId.parse(req.params.id);
    // Another department's record looks absent to a Department Head, so IDs cannot be probed.
    const allowed = !isHead(req) || req.user.departmentId?.toString() === id.toLowerCase();
    const department = allowed ? await Department.findById(id) : null;
    if (!department) return res.status(404).json({ error: 'Not found' });
    res.json(department);
  });

  router.post('/', requireRole(ROLES.ADMIN), async (req, res) => {
    res.status(201).json(await Department.create(departmentCreate.parse(req.body)));
  });

  // No delete route: departments with history are deactivated instead.
  router.patch('/:id', requireRole(ROLES.ADMIN), async (req, res) => {
    const department = await Department.findById(objectId.parse(req.params.id));
    if (!department) return res.status(404).json({ error: 'Not found' });
    department.set(departmentPatch.parse(req.body));
    await department.save();
    res.json(department);
  });

  return router;
}
