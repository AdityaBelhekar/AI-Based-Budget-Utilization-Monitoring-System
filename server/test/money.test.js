import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { parseCsv } from '../src/csv.js';
import { AuditLog, Budget, Department, ROLES, Transaction, User, initModels } from '../src/models.js';
import { croreToPaise, rupeesToPaise, utilizationPct } from '../src/money.js';

const PASSWORD = 'test-password-long-enough';
const FY = '2024-25';
const PDF = Buffer.from('%PDF-1.7 test');

let db, app, deptA, deptB;
const agents = {};

async function signIn(email) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return agent;
}

async function makeBudget(department, allocatedPaise = 1_000_00, project = '', financialYear = FY) {
  const res = await agents.admin
    .post('/api/budgets')
    .send({ financialYear, departmentId: department.id, allocatedPaise, ...(project ? { project } : {}) })
    .expect(201);
  return res.body;
}

const expense = (budget, over = {}) => ({ budgetId: budget.id, date: '2024-06-15', amountPaise: 100_00, category: 'Equipment', ...over });
const spentOf = async (id) => (await Budget.findById(id)).spentPaise;

before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(db.getUri('money'));
  await initModels();
  app = createApp({ sessionSecret: 'test-secret' });
  const passwordHash = await hashPassword(PASSWORD);
  [deptA, deptB] = await Department.create([
    { name: 'Department A', code: 'A1' },
    { name: 'Department B', code: 'B1' },
  ]);
  await User.create([
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

describe('money helpers', () => {
  test('crore and rupees convert exactly', () => {
    assert.equal(croreToPaise('6879.23'), 6_879_230_000_000);
    assert.equal(croreToPaise('205250.01'), 205_250_010_000_000);
    assert.equal(croreToPaise('-41.5'), -41_500_000_000);
    assert.equal(rupeesToPaise('1234.56'), 123456);
    assert.equal(rupeesToPaise('0.07'), 7);
    assert.equal(rupeesToPaise('19.99'), 1999);
  });

  test('bad or over-precise amounts are refused', () => {
    for (const bad of ['', 'abc', '1.234', '1,000', '1e5']) assert.throws(() => rupeesToPaise(bad));
    assert.throws(() => rupeesToPaise('99999999999999999'));
  });

  test('utilization rounds to 2 places and survives a zero budget', () => {
    assert.equal(utilizationPct(687_923, 1_192_501), 57.69);
    assert.equal(utilizationPct(5, 0), 0);
  });

  test('CSV handles quotes, commas, doubled quotes and CRLF', () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  });
});

describe('permission matrix', () => {
  const id = '0'.repeat(24);
  const matrix = [
    ['get', '/api/budgets', null, { anon: 401, head: 200, finance: 200, admin: 200 }],
    ['post', '/api/budgets', {}, { anon: 401, head: 403, finance: 403, admin: 400 }],
    ['patch', `/api/budgets/${id}`, { reason: 'test reason' }, { anon: 401, head: 403, finance: 403, admin: 404 }],
    ['delete', `/api/budgets/${id}`, null, { anon: 401, head: 403, finance: 403, admin: 404 }],
    ['get', '/api/transactions', null, { anon: 401, head: 200, finance: 200, admin: 403 }],
    ['post', '/api/transactions', {}, { anon: 401, head: 400, finance: 400, admin: 403 }],
    ['post', `/api/transactions/${id}/reverse`, { reason: 'test reason' }, { anon: 401, head: 403, finance: 404, admin: 403 }],
    ['get', `/api/documents/${id}`, null, { anon: 401, head: 404, finance: 404, admin: 403 }],
    ['get', '/api/audit-logs', null, { anon: 401, head: 403, finance: 200, admin: 200 }],
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

describe('budgets', () => {
  test('quarterly amounts must add up exactly', async () => {
    const base = { financialYear: '2023-24', departmentId: deptA.id, allocatedPaise: 100 };
    await agents.admin.post('/api/budgets').send({ ...base, quarterSplit: [25, 25, 25, 24] }).expect(400);
    await agents.admin.post('/api/budgets').send({ ...base, quarterSplit: [25, 25, 25, 25] }).expect(201);
  });

  test('one budget per department, project and year', async () => {
    await agents.admin.post('/api/budgets').send({ financialYear: '2023-24', departmentId: deptA.id, allocatedPaise: 5 }).expect(409);
  });

  test('project allocations cannot exceed the department budget, or be left over it', async () => {
    const parent = await makeBudget(deptA, 1000, '', '2022-23');
    await agents.admin.post('/api/budgets').send({ financialYear: '2022-23', departmentId: deptB.id, allocatedPaise: 5, project: 'Orphan' }).expect(400);
    await makeBudget(deptA, 700, 'Road', '2022-23');
    await agents.admin.post('/api/budgets').send({ financialYear: '2022-23', departmentId: deptA.id, allocatedPaise: 301, project: 'Bridge' }).expect(400);
    assert.equal(await Budget.countDocuments({ project: 'Bridge' }), 0, 'the refused project must not be left behind');
    await agents.admin.patch(`/api/budgets/${parent.id}`).send({ allocatedPaise: 699, reason: 'Cut too deep' }).expect(400);
    assert.equal((await Budget.findById(parent.id)).allocatedPaise, 1000);
  });

  test('an edit needs a reason, and the log keeps old value, new value and who', async () => {
    const budget = await makeBudget(deptA, 500, '', '2021-22');
    await agents.admin.patch(`/api/budgets/${budget.id}`).send({ allocatedPaise: 600 }).expect(400);
    await agents.admin.patch(`/api/budgets/${budget.id}`).send({ allocatedPaise: 600, reason: 'Revised estimate' }).expect(200);
    const res = await agents.head.get(`/api/budgets/${budget.id}/history`).expect(200);
    const [entry] = res.body;
    assert.equal(entry.before.allocatedPaise, 500);
    assert.equal(entry.after.allocatedPaise, 600);
    assert.equal(entry.reason, 'Revised estimate');
    assert.equal(entry.actorName, 'Admin');
  });

  test('a budget with spending cannot be deleted; an unused one can', async () => {
    const used = await makeBudget(deptA, 500, '', '2020-21');
    await agents.finance.post('/api/transactions').send(expense(used, { date: '2020-06-01', amountPaise: 10 })).expect(201);
    await agents.admin.delete(`/api/budgets/${used.id}`).expect(409);
    const unused = await makeBudget(deptA, 500, '', '2019-20');
    await agents.admin.delete(`/api/budgets/${unused.id}`).expect(204);
  });

  test('a Department Head cannot see another department\'s budget', async () => {
    const other = await makeBudget(deptB);
    await agents.head.get(`/api/budgets/${other.id}`).expect(404);
    await agents.head.get(`/api/budgets/${other.id}/history`).expect(404);
    const res = await agents.head.get(`/api/budgets?departmentId=${deptB.id}`).expect(200);
    assert.ok(res.body.items.every((b) => b.departmentId === deptA.id));
  });
});

describe('expenditure', () => {
  let budget;
  before(async () => {
    budget = await makeBudget(deptA, 1_000_00);
  });

  test('recording an expense updates utilization on the next read', async () => {
    await agents.head.post('/api/transactions').send(expense(budget, { amountPaise: 250_00 / 10 })).expect(201);
    const res = await agents.head.get(`/api/budgets/${budget.id}`).expect(200);
    assert.equal(res.body.spentPaise, 2500);
    assert.equal(res.body.remainingPaise, 97500);
    assert.equal(res.body.utilizationPct, 2.5);
  });

  test('dates outside the year, future dates and non-positive amounts are refused', async () => {
    const post = (over) => agents.finance.post('/api/transactions').send(expense(budget, over));
    await post({ date: '2024-03-31' }).expect(400);
    await post({ date: '2025-04-01' }).expect(400);
    await post({ date: '2024-02-30' }).expect(400);
    await post({ amountPaise: 0 }).expect(400);
    await post({ amountPaise: -5 }).expect(400);
    await post({ amountPaise: 1.5 }).expect(400);
    const current = await makeBudget(deptA, 100, '', '2030-31');
    await agents.finance.post('/api/transactions').send(expense(current, { date: '2030-06-01' })).expect(400);
  });

  test('overspending is recorded, not blocked', async () => {
    const small = await makeBudget(deptB, 100, '', '2018-19');
    await agents.finance.post('/api/transactions').send(expense(small, { date: '2018-06-01', amountPaise: 150 })).expect(201);
    assert.equal((await Budget.findById(small.id)).toJSON().utilizationPct, 150);
  });

  test('a Department Head cannot spend from another department', async () => {
    const other = await Budget.findOne({ departmentId: deptB.id, financialYear: FY });
    await agents.head.post('/api/transactions').send(expense({ id: other.id })).expect(404);
    await agents.finance.post('/api/transactions').send(expense({ id: other.id })).expect(201);
  });

  test('project spending also counts on the department budget', async () => {
    const parent = await makeBudget(deptA, 1000, '', '2017-18');
    const project = await makeBudget(deptA, 400, 'School', '2017-18');
    await agents.head.post('/api/transactions').send(expense(project, { date: '2017-06-01', amountPaise: 300 })).expect(201);
    assert.equal(await spentOf(project.id), 300);
    assert.equal(await spentOf(parent.id), 300);
  });

  test('concurrent writes all count', async () => {
    const busy = await makeBudget(deptB, 1_000_000, '', '2016-17');
    const post = () => agents.finance.post('/api/transactions').send(expense(busy, { date: '2016-06-01', amountPaise: 7 }));
    const results = await Promise.all(Array.from({ length: 10 }, post));
    const saved = results.filter((r) => r.status === 201).length;
    assert.equal(saved, 10);
    assert.equal(await spentOf(busy.id), 70);
  });

  test('a failed write leaves nothing behind', async () => {
    const before = await Transaction.countDocuments();
    const spent = await spentOf(budget.id);
    const res = await agents.finance.post('/api/transactions').send(expense(budget, { category: 'Not a category' }));
    assert.equal(res.status, 400);
    assert.equal(await Transaction.countDocuments(), before);
    assert.equal(await spentOf(budget.id), spent);
  });

  test('reversing restores the total, keeps the original, and works only once', async () => {
    const spent = await spentOf(budget.id);
    const { body: original } = await agents.head.post('/api/transactions').send(expense(budget, { amountPaise: 900 })).expect(201);
    await agents.head.post(`/api/transactions/${original.id}/reverse`).send({ reason: 'Wrong amount' }).expect(403);
    await agents.finance.post(`/api/transactions/${original.id}/reverse`).send({}).expect(400);
    const { body: reversal } = await agents.finance.post(`/api/transactions/${original.id}/reverse`).send({ reason: 'Wrong amount' }).expect(201);
    assert.equal(reversal.amountPaise, -900);
    assert.equal(reversal.reversesId, original.id);
    assert.equal(await spentOf(budget.id), spent);
    await agents.finance.get(`/api/transactions/${original.id}`).expect(200);
    await agents.finance.post(`/api/transactions/${original.id}/reverse`).send({ reason: 'Again' }).expect(409);
    await agents.finance.post(`/api/transactions/${reversal.id}/reverse`).send({ reason: 'Undo' }).expect(400);
    assert.equal(await spentOf(budget.id), spent);
  });

  test('transactions and audit entries cannot be changed, even by code', async () => {
    await assert.rejects(Transaction.updateOne({}, { amountPaise: 1 }), /append-only/);
    await assert.rejects(Transaction.deleteMany({}), /append-only/);
    await assert.rejects(AuditLog.deleteOne({}), /append-only/);
    const entry = await AuditLog.findOne();
    entry.reason = 'tampered';
    await assert.rejects(entry.save(), /append-only/);
  });

  test('audit routes offer no way to change anything', async () => {
    const [entry] = (await agents.admin.get('/api/audit-logs?limit=1').expect(200)).body.items;
    await agents.admin.delete(`/api/audit-logs/${entry.id}`).expect(404);
    await agents.admin.patch(`/api/audit-logs/${entry.id}`).send({}).expect(404);
  });

  test('every expense has an audit entry naming who recorded it', async () => {
    const { body } = await agents.head.post('/api/transactions').send(expense(budget, { amountPaise: 11 })).expect(201);
    const entry = await AuditLog.findOne({ entity: 'transaction', entityId: body.id });
    assert.equal(entry.actorName, 'Head');
    assert.equal(entry.after.amountPaise, 11);
  });

  test('list filters stay inside a Department Head\'s scope', async () => {
    const res = await agents.head.get(`/api/transactions?departmentId=${deptB.id}`).expect(200);
    assert.ok(res.body.items.length > 0);
    assert.ok(res.body.items.every((t) => t.departmentId === deptA.id));
    await agents.finance.get('/api/transactions?departmentId[$ne]=x').expect(200);
  });
});

describe('CSV import', () => {
  const HEADER = 'budget_id,date,amount_rupees,category,description,payee';
  const send = (agent, body) => agent.post('/api/transactions/import').set('Content-Type', 'text/csv').send(body);
  let budget;
  before(async () => {
    budget = await makeBudget(deptA, 10_000_000, '', '2015-16');
  });

  test('a clean file imports every row exactly', async () => {
    const csv = `${HEADER}\n${budget.id},2015-06-01,1234.56,Equipment,"Laptops, 2 units",Vendor\n${budget.id},2015-06-02,0.07,Travel,,\n`;
    const res = await send(agents.head, csv).expect(201);
    assert.equal(res.body.imported, 2);
    assert.equal(await spentOf(budget.id), 123463);
  });

  test('one bad row rejects the whole file, with errors by row number', async () => {
    const spent = await spentOf(budget.id);
    const csv = `${HEADER}\n${budget.id},2015-06-01,10.00,Equipment,,\n${budget.id},1999-01-01,10.00,Equipment,,\n${budget.id},2015-06-01,abc,Equipment,,\n`;
    const res = await send(agents.finance, csv).expect(400);
    assert.deepEqual(res.body.rows.map((r) => r.row), [3, 4]);
    assert.equal(await spentOf(budget.id), spent);
  });

  test('another department\'s budget counts as a bad row, and a wrong header is refused', async () => {
    const other = await Budget.findOne({ departmentId: deptB.id, financialYear: FY });
    const res = await send(agents.head, `${HEADER}\n${other.id},2024-06-01,1.00,Equipment,,\n`).expect(400);
    assert.match(res.body.rows[0].message, /not found/i);
    await send(agents.head, 'a,b\n1,2\n').expect(400);
  });
});

describe('documents', () => {
  let transaction;
  before(async () => {
    const budget = await makeBudget(deptA, 1000, '', '2014-15');
    transaction = (await agents.head.post('/api/transactions').send(expense(budget, { date: '2014-06-01', amountPaise: 5 })).expect(201)).body;
  });
  const attach = (agent, buffer, filename) => agent.post(`/api/transactions/${transaction.id}/documents`).attach('file', buffer, filename);

  test('a real PDF uploads and downloads unchanged, as an attachment', async () => {
    const { body } = await attach(agents.head, PDF, 'bill.pdf').expect(201);
    const res = await agents.head.get(`/api/documents/${body.id}`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c)).on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    assert.deepEqual(res.body, PDF);
    assert.match(res.headers['content-disposition'], /attachment/);
    assert.equal(res.headers['content-type'], 'application/pdf');
    const list = await agents.finance.get(`/api/transactions/${transaction.id}/documents`).expect(200);
    assert.equal(list.body[0].name, 'bill.pdf');
  });

  test('the type comes from the content, not the file name', async () => {
    await attach(agents.head, Buffer.from('<script>alert(1)</script>'), 'bill.pdf').expect(415);
    await attach(agents.head, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'photo.txt').expect(201);
  });

  test('files over 5 MB are refused', async () => {
    await attach(agents.head, Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]), 'big.pdf').expect(413);
  });

  test('another department cannot read the document', async () => {
    const budget = await makeBudget(deptB, 1000, '', '2013-14');
    const { body: t } = await agents.finance.post('/api/transactions').send(expense(budget, { date: '2013-06-01', amountPaise: 5 })).expect(201);
    const { body: doc } = await agents.finance.post(`/api/transactions/${t.id}/documents`).attach('file', PDF, 'x.pdf').expect(201);
    await agents.head.get(`/api/documents/${doc.id}`).expect(404);
    await agents.head.get(`/api/transactions/${t.id}/documents`).expect(404);
    await agents.head.post(`/api/transactions/${t.id}/documents`).attach('file', PDF, 'x.pdf').expect(404);
  });
});
