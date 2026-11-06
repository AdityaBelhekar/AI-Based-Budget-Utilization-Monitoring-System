import mongoose from 'mongoose';
import { hashPassword, passwordSchema } from './auth.js';
import { connectDb } from './db.js';
import { Department, ROLES, User } from './models.js';

// Creates the first Admin, plus demo Finance Officer and Department Head accounts when their variables are set.
// Passwords only ever come from the environment. Safe to re-run: existing emails are left alone.
export async function seedUsers(env = process.env) {
  const wanted = [
    { name: env.SEED_ADMIN_NAME || 'Administrator', email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD, role: ROLES.ADMIN },
    { name: env.DEMO_FINANCE_NAME || 'Finance Officer', email: env.DEMO_FINANCE_EMAIL, password: env.DEMO_FINANCE_PASSWORD, role: ROLES.FINANCE },
    { name: env.DEMO_HEAD_NAME || 'Department Head', email: env.DEMO_HEAD_EMAIL, password: env.DEMO_HEAD_PASSWORD, role: ROLES.HEAD, departmentCode: env.DEMO_HEAD_DEPARTMENT || 'PETROLEUM' },
  ];
  if (!wanted[0].email && !(await User.exists({ role: ROLES.ADMIN }))) throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set');
  const created = [];
  for (const { departmentCode, password, ...user } of wanted) {
    if (!user.email || (await User.exists({ email: user.email.toLowerCase() }))) continue;
    if (user.role === ROLES.ADMIN && (await User.exists({ role: ROLES.ADMIN }))) continue;
    let departmentId = null;
    if (departmentCode) {
      departmentId = (await Department.findOne({ code: departmentCode }))?._id;
      if (!departmentId) throw new Error(`No department with code ${departmentCode}; run the data seed first`);
    }
    await User.create({ ...user, departmentId, passwordHash: await hashPassword(passwordSchema.parse(password ?? '')) });
    created.push(`${user.role} ${user.email}`);
  }
  return created;
}

if (process.argv[1] === import.meta.filename) {
  await connectDb(process.env.MONGODB_URI);
  const created = await seedUsers();
  console.log(created.length ? `Created: ${created.join(', ')}` : 'All accounts already exist; nothing changed');
  await mongoose.disconnect();
}
