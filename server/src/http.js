import { z } from 'zod';
import { ROLES } from './models.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const objectId = z.string().regex(/^[a-f\d]{24}$/i);
export const safePaise = z.number().int().refine(Number.isSafeInteger, 'Amount is too large');
export const fyLabel = z.string().refine((fy) => {
  const match = /^(\d{4})-(\d{2})$/.exec(fy);
  return match && String(Number(match[1]) + 1).slice(2) === match[2];
}, 'Use a financial year such as 2026-27');
export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
};

export const isHead = (user) => user.role === ROLES.HEAD;
// Another department's record looks absent to a Department Head, so IDs cannot be probed.
export const canSeeDepartment = (user, departmentId) =>
  !isHead(user) || user.departmentId?.toString() === departmentId.toString();

export async function paginate(query, { page, limit }) {
  const [items, total] = await Promise.all([
    query.clone().skip((page - 1) * limit).limit(limit),
    query.model.countDocuments(query.getFilter()),
  ]);
  return { items, total, page, limit };
}
