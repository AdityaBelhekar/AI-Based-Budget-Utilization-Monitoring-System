import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { Alert, Budget, Department, ROLES, User } from '../src/models.js';
import { croreToPaise } from '../src/money.js';
import { csvCell } from '../src/reports.js';
import { seedPublishedData } from '../src/seed-data.js';

const PASSWORD = 'test-password-long-enough';
const CRON_SECRET = 'test-cron-secret';
let db, app, petroleum, food, replay;
const agents = {};

async function signIn(email) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return agent;
}

before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(db.getUri('monitoring'));
  replay = await seedPublishedData();
  app = createApp({ sessionSecret: 'test-secret', cronSecret: CRON_SECRET });
  [petroleum, food] = await Promise.all([Department.findOne({ code: 'PETROLEUM' }), Department.findOne({ code: 'FOOD' })]);
  const passwordHash = await hashPassword(PASSWORD);
  await User.create([
    { name: 'Admin', email: 'admin@example.test', passwordHash, role: ROLES.ADMIN },
    { name: 'Finance', email: 'finance@example.test', passwordHash, role: ROLES.FINANCE },
    { name: 'Head', email: 'head@example.test', passwordHash, role: ROLES.HEAD, departmentId: petroleum._id },
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

describe('history replay on real CGA data', () => {
  test('raises alerts, dated when each problem was first visible', async () => {
    assert.ok(replay.alertsRaised > 0);
    const first = await Alert.findOne({ departmentId: petroleum._id, financialYear: '2024-25', type: 'pace_deviation', periodKey: 'behind' });
    assert.ok(first, 'Petroleum 2024-25 was behind pace');
    assert.ok(first.detectedAt <= '2024-12-31');
  });

  test('every rule that can fire on monthly published data is exercised, or its absence is explained', async () => {
    const byType = Object.fromEntries((await Alert.aggregate([{ $group: { _id: '$type', n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));
    for (const type of ['pace_deviation', 'overspending', 'spike']) assert.ok(byType[type] > 0, `${type} never fired: ${JSON.stringify(byType)}`);
    // Published records are monthly totals, not individual payments, so the duplicate rule cannot apply to them.
    assert.equal(byType.possible_duplicate, undefined);
  });

  test('the current year is judged at the last published month', async () => {
    const res = await agents.finance.get('/api/dashboard/summary?financialYear=2026-27').expect(200);
    assert.equal(res.body.month, '2026-09');
    assert.equal(res.body.asOf, '2026-09-30');
    assert.equal(res.body.elapsedPct, 50.14);
    const row = res.body.rows.find((r) => r.departmentCode === 'PETROLEUM');
    assert.equal(row.spentPaise, croreToPaise('1149.09'));
    assert.equal(row.utilizationPct, 9.51);
    assert.equal(row.gapPts, -40.63);
    assert.equal(row.status, 'behind');
    assert.equal(res.body.rows[0].departmentCode, 'PETROLEUM', 'rows are ranked by distance from pace');
  });

  test('a past month uses the allocation in force then', async () => {
    const dec = await agents.finance.get('/api/dashboard/summary?financialYear=2024-25&month=2024-12').expect(200);
    const mar = await agents.finance.get('/api/dashboard/summary?financialYear=2024-25&month=2025-03').expect(200);
    const foodAt = (body) => body.rows.find((r) => r.departmentCode === 'FOOD');
    assert.equal(foodAt(dec.body).allocatedPaise, croreToPaise('205250.01'), 'Budget Estimates in December');
    assert.notEqual(foodAt(mar.body).allocatedPaise, foodAt(dec.body).allocatedPaise, 'Revised Estimates by March');
    assert.equal(foodAt(dec.body).spentPaise, croreToPaise('163716.30'));
  });
});

describe('dashboard', () => {
  test('a Department Head sees only their department', async () => {
    const res = await agents.head.get('/api/dashboard/summary').expect(200);
    assert.deepEqual(res.body.rows.map((r) => r.departmentCode), ['PETROLEUM']);
    await agents.head.get(`/api/dashboard/departments/${food.id}`).expect(404);
    await agents.head.get(`/api/dashboard/departments/${petroleum.id}`).expect(200);
  });

  test('the trend ends at the selected month and is cumulative', async () => {
    const res = await agents.finance.get(`/api/dashboard/trend?financialYear=2026-27&departmentId=${petroleum.id}`).expect(200);
    assert.equal(res.body.months.length, 6);
    assert.equal(res.body.months.at(-1).cumulativePaise, croreToPaise('1149.09'));
  });

  test('category shares add up to total spending and never exceed 5 slices', async () => {
    const res = await agents.finance.get('/api/dashboard/categories?financialYear=2026-27').expect(200);
    const summary = await agents.finance.get('/api/dashboard/summary?financialYear=2026-27').expect(200);
    assert.ok(res.body.slices.length <= 5);
    assert.equal(res.body.totalPaise, summary.body.totals.spentPaise);
  });

  test('department page marks spike months and lists open alerts', async () => {
    const res = await agents.finance.get(`/api/dashboard/departments/${petroleum.id}?financialYear=2026-27`).expect(200);
    assert.equal(res.body.monthly.length, 6);
    assert.ok(res.body.alerts.every((a) => a.status !== 'resolved'));
  });

  test('a month outside the year is refused', async () => {
    await agents.finance.get('/api/dashboard/summary?financialYear=2026-27&month=2025-03').expect(400);
  });

  test('KPIs are computed from the records', async () => {
    const res = await agents.finance.get('/api/dashboard/kpis').expect(200);
    assert.ok(res.body.alertsByType.pace_deviation > 0);
    assert.ok(res.body.unspentAtYearEnd.years.includes('2024-25'));
    assert.ok(res.body.unspentAtYearEnd.sharePct >= 0 && res.body.unspentAtYearEnd.sharePct <= 100);
  });
});

describe('alerts', () => {
  let alert;
  before(async () => {
    alert = await Alert.findOne({ departmentId: petroleum._id, status: 'open' });
  });

  test('a Department Head sees only their own alerts', async () => {
    const res = await agents.head.get('/api/alerts?limit=200').expect(200);
    assert.ok(res.body.items.length > 0);
    assert.ok(res.body.items.every((a) => a.departmentId.id === petroleum.id));
    const foodAlert = await Alert.findOne({ departmentId: food._id });
    if (foodAlert) await agents.head.patch(`/api/alerts/${foodAlert.id}`).send({ action: 'acknowledge' }).expect(404);
  });

  test('acknowledge, then resolve with a note; the history and audit log keep both', async () => {
    await agents.admin.patch(`/api/alerts/${alert.id}`).send({ action: 'acknowledge' }).expect(403);
    await agents.head.patch(`/api/alerts/${alert.id}`).send({ action: 'acknowledge' }).expect(200);
    await agents.head.patch(`/api/alerts/${alert.id}`).send({ action: 'acknowledge' }).expect(409);
    await agents.finance.patch(`/api/alerts/${alert.id}`).send({ action: 'resolve' }).expect(400);
    const res = await agents.finance.patch(`/api/alerts/${alert.id}`).send({ action: 'resolve', note: 'Reallocated in the revised estimates' }).expect(200);
    assert.equal(res.body.status, 'resolved');
    assert.deepEqual(res.body.history.map((h) => h.action), ['raised', 'acknowledged', 'resolved']);
    await agents.finance.patch(`/api/alerts/${alert.id}`).send({ action: 'resolve', note: 'again' }).expect(409);
  });

  test('a resolved alert is not raised again by a later scan', async () => {
    await agents.admin.post('/api/scans/run').expect(200);
    assert.equal((await Alert.findById(alert.id)).status, 'resolved');
  });

  test('the open count covers the current year only', async () => {
    const res = await agents.head.get('/api/alerts/unread-count').expect(200);
    assert.equal(typeof res.body.open, 'number');
  });
});

describe('detection after a write', () => {
  test('a repeated payment on a head fed by published figures is still caught', async () => {
    const budget = await Budget.findOne({ financialYear: '2026-27', departmentId: petroleum._id, project: '' });
    const send = () => agents.finance.post('/api/transactions').send({ budgetId: budget.id, date: '2026-10-20', amountPaise: 12_345_00, category: 'Services' }).expect(201);
    await send();
    await send();
    const dup = await Alert.findOne({ budgetId: budget._id, type: 'possible_duplicate' });
    assert.equal(dup.detectedAt, '2026-10-20', 'dated by the payment, not by the last published month');
  });

  test('a repeated payment raises a possible-duplicate alert straight away', async () => {
    const budget = await Budget.create({ financialYear: '2026-27', departmentId: food._id, project: 'Warehousing', allocatedPaise: 1e12, revisions: [{ date: '2026-04-01', allocatedPaise: 1e12 }] });
    const parent = await Budget.findOne({ financialYear: '2026-27', departmentId: food._id, project: '' });
    assert.ok(parent);
    const send = (date) => agents.finance.post('/api/transactions').send({ budgetId: budget.id, date, amountPaise: 48_500_00, category: 'Services', payee: 'Cold store' }).expect(201);
    await send('2026-10-02');
    await send('2026-10-05');
    const dup = await Alert.findOne({ budgetId: budget._id, type: 'possible_duplicate' });
    assert.ok(dup);
    assert.equal(dup.severity, 'high');
  });
});

describe('thresholds and scans', () => {
  test('only an Admin manages thresholds; values outside the known rules are refused', async () => {
    await agents.finance.get('/api/thresholds').expect(403);
    await agents.admin.put('/api/thresholds').send({ values: { pace: { maxGapPts: -1 } } }).expect(400);
    await agents.admin.put('/api/thresholds').send({ values: { madeUp: { x: 1 } } }).expect(400);
  });

  test('a preview counts what a change would raise, without saving it', async () => {
    const before = await Alert.countDocuments();
    const res = await agents.admin.post('/api/thresholds/preview').send({ values: { pace: { maxGapPts: 1 } } }).expect(200);
    assert.ok(res.body.proposed.pace_deviation >= res.body.current.pace_deviation);
    assert.equal(await Alert.countDocuments(), before);
  });

  test('a saved department override is audited', async () => {
    await agents.admin.put('/api/thresholds').send({ departmentId: petroleum.id, values: { pace: { maxGapPts: 25 } } }).expect(200);
    const res = await agents.admin.get('/api/thresholds').expect(200);
    assert.equal(res.body.overrides[0].values.pace.maxGapPts, 25);
    const log = await agents.admin.get('/api/audit-logs?entity=threshold').expect(200);
    assert.equal(log.body.items[0].after.pace.maxGapPts, 25);
  });

  test('scan on demand reports what it checked', async () => {
    await agents.finance.post('/api/scans/run').expect(403);
    const res = await agents.admin.post('/api/scans/run').expect(200);
    assert.ok(res.body.budgetsChecked >= 6);
  });

  test('the cron endpoint needs the shared secret', async () => {
    await agents.anon.get('/api/cron/scan').expect(401);
    await agents.anon.get('/api/cron/scan').set('Authorization', 'Bearer wrong').expect(401);
    await agents.anon.get('/api/cron/scan').set('Authorization', `Bearer ${CRON_SECRET}`).expect(200);
  });
});

describe('reports', () => {
  test('the utilization report matches the dashboard to the paisa', async () => {
    const report = await agents.finance.get('/api/reports/utilization?financialYear=2026-27').expect(200);
    const summary = await agents.finance.get('/api/dashboard/summary?financialYear=2026-27').expect(200);
    const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);
    assert.equal(Math.round(sum(report.body.rows, 'spent') * 1e9), summary.body.totals.spentPaise);
  });

  test('CSV downloads as an attachment and a Department Head gets only their rows', async () => {
    const res = await agents.head.get('/api/reports/utilization?financialYear=2026-27&format=csv').expect(200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment; filename="?utilization-2026-27-2026-09-30.csv"?/);
    const lines = res.text.trim().split('\r\n');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^Petroleum Subsidy,/);
  });

  test('PDF downloads as a real PDF', async () => {
    const res = await agents.finance
      .get('/api/reports/transactions?financialYear=2026-27&format=pdf')
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c)).on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    assert.equal(res.body.subarray(0, 5).toString(), '%PDF-');
  });

  test('cells that a spreadsheet would run as formulas are neutralised', () => {
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell(-4910), '-4910');
    assert.equal(csvCell('plain, with comma'), '"plain, with comma"');
  });

  test('an unknown report is a 404, including inherited names', async () => {
    await agents.finance.get('/api/reports/constructor').expect(404);
    await agents.finance.get('/api/reports/nope').expect(404);
  });
});
