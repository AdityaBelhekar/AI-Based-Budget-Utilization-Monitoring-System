import mongoose from 'mongoose';
import { hashPassword, passwordSchema } from './auth.js';
import { ROLES, User } from './models.js';

// Creates the first Admin, the only account that cannot be made from inside the app. Safe to re-run.
export async function seedAdmin() {
  const { SEED_ADMIN_NAME = 'Administrator', SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } = process.env;
  if (await User.exists({ role: ROLES.ADMIN })) return false;
  if (!SEED_ADMIN_EMAIL) throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set');
  await User.create({
    name: SEED_ADMIN_NAME,
    email: SEED_ADMIN_EMAIL,
    passwordHash: await hashPassword(passwordSchema.parse(SEED_ADMIN_PASSWORD)),
    role: ROLES.ADMIN,
  });
  return true;
}

if (process.argv[1] === import.meta.filename) {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log((await seedAdmin()) ? 'Admin created' : 'An Admin already exists; nothing changed');
  await mongoose.disconnect();
}
