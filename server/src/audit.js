import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from './auth.js';
import { objectId, pageQuery, paginate } from './http.js';
import { AuditLog, ROLES } from './models.js';

const auditQuery = z.object({
  ...pageQuery,
  actorId: objectId.optional(),
  entity: z.string().max(40).optional(),
  entityId: objectId.optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

// actor is a user document, or null for the published-data import.
export async function writeAudit(session, actor, { action, entity, entityId, before = null, after = null, reason = '' }) {
  await AuditLog.create(
    [{ actorId: actor?._id ?? null, actorName: actor?.name ?? 'Published data import', action, entity, entityId, before, after, reason }],
    { session },
  );
}

export function auditRoutes() {
  const router = Router();
  router.use(requireRole(ROLES.ADMIN, ROLES.FINANCE));

  // No update or delete route exists, by design.
  router.get('/', async (req, res) => {
    const { from, to, page, limit, ...filter } = auditQuery.parse(req.query);
    if (from || to) {
      filter.at = {};
      if (from) filter.at.$gte = new Date(`${from}T00:00:00+05:30`);
      if (to) filter.at.$lte = new Date(`${to}T23:59:59.999+05:30`);
    }
    res.json(await paginate(AuditLog.find(filter).sort('-at'), { page, limit }));
  });

  return router;
}
