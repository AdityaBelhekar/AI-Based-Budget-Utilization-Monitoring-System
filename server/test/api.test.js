import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { Department, ROLES, User, initModels } from '../src/models.js';

const PASSWORD = 'test-password-long-enough';
const makeApp = () => createApp({ sessionSecret: 'test-secret' });

let db, app, passwordHash, deptA, deptB, adminUser;
const agents = {};

async function signIn(email, target = app) {
  const agent = request.agent(target);
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return agent;
}

before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(db.getUri('test'));
  await initModels();
  app = makeApp();
  passwordHash = await hashPassword(PASSWORD);
  [deptA, deptB] = await Department.create([
    { name: 'Department A', code: 'A1' },
    { name: 'Department B', code: 'B1' },
  ]);
  [adminUser] = await User.create([
    { name: 'Admin', email: 'admin@example.test', passwordHash, role: ROLES.ADMIN },
    { name: 'Finance', email: 'finance@example.test', passwordHash, role: ROLES.FINANCE },
    { name: 'Head', email: 'head@example.test', passwordHash, role: ROLES.HEAD, departmentId: deptA.id },
  ]);
  agents.admin = await signIn('admin@example.test');
  agents.finance = await signIn('finance@example.test');
  agents.head = await signIn('head@example.test');
  agents.anon = request(app);
});

after(async () => {
  await mongoose.disconnect();
  await db.stop();
});

describe('permission matrix', () => {
  const id = '0'.repeat(24);
  // [method, path, body, expected status per role]; 400 and 404 mean the role got past the guard.
  const matrix = [
    ['get', '/api/auth/me', null, { anon: 401, head: 200, finance: 200, admin: 200 }],
    ['get', '/api/dashboard/summary', null, { anon: 401, head: 200, finance: 200, admin: 200 }],
    ['get', '/api/users', null, { anon: 401, head: 403, finance: 403, admin: 200 }],
    ['post', '/api/users', {}, { anon: 401, head: 403, finance: 403, admin: 400 }],
    ['patch', `/api/users/${id}`, {}, { anon: 401, head: 403, finance: 403, admin: 404 }],
    ['get', '/api/departments', null, { anon: 401, head: 200, finance: 200, admin: 200 }],
    ['post', '/api/departments', {}, { anon: 401, head: 403, finance: 403, admin: 400 }],
    ['patch', `/api/departments/${id}`, {}, { anon: 401, head: 403, finance: 403, admin: 404 }],
  ];
  for (const [method, path, body, expected] of matrix) {
    for (const [role, status] of Object.entries(expected)) {
      test(`${method.toUpperCase()} ${path} as ${role} returns ${status}`, async () => {
        const req = agents[role][method](path);
        await (body ? req.send(body) : req).expect(status);
      });
    }
  }
});

describe('sign-in', () => {
  test('wrong password and unknown email give the same error', async () => {
    const wrong = await request(app).post('/api/auth/login').send({ email: 'head@example.test', password: 'nope' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'ghost@example.test', password: 'nope' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
  });

  test('the session cookie is httpOnly and SameSite=Strict', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'head@example.test', password: PASSWORD });
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  test('a query operator cannot stand in for an email', async () => {
    await request(app).post('/api/auth/login').send({ email: { $ne: null }, password: PASSWORD }).expect(400);
  });

  test('the password hash never appears in a response', async () => {
    const res = await agents.admin.get('/api/users').expect(200);
    assert.ok(res.body.length >= 3);
    assert.ok(res.body.every((u) => !('passwordHash' in u)));
  });

  test('sign out ends the session', async () => {
    const agent = await signIn('finance@example.test');
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
  });

  test('the eleventh attempt in a window is refused', async () => {
    const limited = makeApp();
    for (let i = 0; i < 10; i++) {
      await request(limited).post('/api/auth/login').send({ email: 'x@example.test', password: 'x' }).expect(401);
    }
    await request(limited).post('/api/auth/login').send({ email: 'x@example.test', password: 'x' }).expect(429);
  });
});

describe('department scope', () => {
  test('a Department Head sees only their department in the list', async () => {
    const res = await agents.head.get('/api/departments').expect(200);
    assert.deepEqual(res.body.map((d) => d.code), ['A1']);
  });

  test('a Department Head gets 404 for another department by ID', async () => {
    await agents.head.get(`/api/departments/${deptA.id}`).expect(200);
    await agents.head.get(`/api/departments/${deptB.id}`).expect(404);
  });

  test('a Finance Officer can read any department', async () => {
    await agents.finance.get(`/api/departments/${deptB.id}`).expect(200);
  });
});

describe('user management', () => {
  const base = { name: 'New User', password: PASSWORD };

  test('a deactivated user is refused on their next request', async () => {
    await agents.admin
      .post('/api/users')
      .send({ ...base, email: 'leaver@example.test', role: ROLES.FINANCE })
      .expect(201);
    const leaver = await signIn('leaver@example.test');
    await leaver.get('/api/auth/me').expect(200);
    const { id } = await User.findOne({ email: 'leaver@example.test' });
    await agents.admin.patch(`/api/users/${id}`).send({ active: false }).expect(200);
    await leaver.get('/api/auth/me').expect(401);
    await request(app).post('/api/auth/login').send({ email: 'leaver@example.test', password: PASSWORD }).expect(401);
  });

  test('a Department Head must have a real department', async () => {
    const head = { ...base, email: 'nodept@example.test', role: ROLES.HEAD };
    await agents.admin.post('/api/users').send(head).expect(400);
    await agents.admin.post('/api/users').send({ ...head, departmentId: '0'.repeat(24) }).expect(400);
    await agents.admin.post('/api/users').send({ ...head, departmentId: deptB.id }).expect(201);
  });

  test('moving a user out of the Department Head role clears their department', async () => {
    const { id } = await User.findOne({ email: 'nodept@example.test' });
    const res = await agents.admin.patch(`/api/users/${id}`).send({ role: ROLES.FINANCE }).expect(200);
    assert.equal(res.body.departmentId, null);
  });

  test('a duplicate email is refused, whatever its case', async () => {
    await agents.admin
      .post('/api/users')
      .send({ ...base, email: 'ADMIN@example.test', role: ROLES.FINANCE })
      .expect(409);
  });

  test('passwords that are short or too long for bcrypt are refused', async () => {
    const make = (password) => ({ ...base, password, email: 'pw@example.test', role: ROLES.FINANCE });
    await agents.admin.post('/api/users').send(make('short')).expect(400);
    await agents.admin.post('/api/users').send(make('x'.repeat(73))).expect(400);
  });

  test('an Admin cannot remove their own access', async () => {
    await agents.admin.patch(`/api/users/${adminUser.id}`).send({ active: false }).expect(400);
    await agents.admin.patch(`/api/users/${adminUser.id}`).send({ role: ROLES.FINANCE }).expect(400);
  });

  test('unexpected fields are refused rather than ignored', async () => {
    await agents.admin.patch(`/api/users/${adminUser.id}`).send({ passwordHash: 'x' }).expect(400);
  });
});

test('departments cannot be deleted', async () => {
  await agents.admin.delete(`/api/departments/${deptB.id}`).expect(404);
});

test('summary reports the financial year position', async () => {
  const res = await agents.head.get('/api/dashboard/summary').expect(200);
  assert.match(res.body.financialYear, /^\d{4}-\d{2}$/);
});
