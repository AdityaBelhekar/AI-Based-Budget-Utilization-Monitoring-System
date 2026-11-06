import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User } from './models.js';

const BCRYPT_COST = 12;
// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('no-such-user', BCRYPT_COST);

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_COST);

// bcrypt silently ignores bytes past 72, so longer passwords are refused rather than truncated.
export const passwordSchema = z
  .string()
  .min(12)
  .refine((p) => Buffer.byteLength(p) <= 72, 'Password must be at most 72 bytes');

const loginSchema = z.object({ email: z.string().email(), password: z.string().max(200) });

export async function requireAuth(req, res, next) {
  const user = req.session.userId ? await User.findById(req.session.userId) : null;
  if (!user?.active) {
    req.session.destroy(() => res.status(401).json({ error: 'Sign in required' }));
    return;
  }
  req.user = user;
  next();
}

export const requireRole =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not permitted' });

export function authRoutes() {
  const router = Router();
  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in 15 minutes.' },
  });

  router.post('/login', loginLimit, async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !matches || !user.active) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.userId = user.id;
    res.json(user);
  });

  router.post('/logout', requireAuth, (req, res) => {
    req.session.destroy(() => res.clearCookie('sid').status(204).end());
  });

  router.get('/me', requireAuth, (req, res) => res.json(req.user));

  return router;
}
