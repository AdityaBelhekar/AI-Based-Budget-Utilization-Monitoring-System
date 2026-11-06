import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { AuditLog, Budget, Department, Transaction } from '../src/models.js';
import { croreToPaise } from '../src/money.js';
import { assertReconciles, seedPublishedData } from '../src/seed-data.js';

let db;
const budgetFor = async (code, financialYear) => {
  const department = await Department.findOne({ code });
  return Budget.findOne({ departmentId: department._id, financialYear });
};
const spentThrough = async (budget, date) => {
  const rows = await Transaction.find({ budgetId: budget._id, date: { $lte: new Date(`${date}T00:00:00Z`) } });
  return rows.reduce((sum, t) => sum + t.amountPaise, 0);
};

before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(db.getUri('seed'));
  const result = await seedPublishedData();
  assert.equal(result.months, 90);
});

after(async () => {
  await mongoose.disconnect();
  await db.stop();
});

test('every budget reconciles to its last published figure', async () => {
  assert.equal(await assertReconciles(), 48);
});

test('the PRD worked example holds at 31 December 2024', async () => {
  const cases = { PETROLEUM: '6879.23', NBS: '40990.68', FOOD: '163716.30', UREA: '95407.98' };
  for (const [code, actual] of Object.entries(cases)) {
    const budget = await budgetFor(code, '2024-25');
    assert.equal(await spentThrough(budget, '2024-12-31'), croreToPaise(actual), code);
  }
});

test('a move from Budget to Revised Estimates is an audited change', async () => {
  const budget = await budgetFor('FOOD', '2024-25');
  const changes = await AuditLog.find({ entity: 'budget', entityId: budget._id, action: 'update' });
  assert.ok(changes.length >= 1);
  assert.equal(changes[0].before.allocatedPaise, croreToPaise('205250.01'));
  assert.match(changes[0].reason, /Revised Estimates/);
});

test('the current year holds published figures through September 2026', async () => {
  const budget = await budgetFor('PETROLEUM', '2026-27');
  assert.equal(budget.spentPaise, croreToPaise('1149.09'));
  assert.equal(budget.allocatedPaise, croreToPaise('12084.51'));
  assert.ok(budget.sourceUrl.startsWith('https://cga.gov.in/'));
});

test('every seeded record carries its source and no invented payee', async () => {
  assert.equal(await Transaction.countDocuments({ sourceUrl: '' }), 0);
  assert.equal(await Transaction.countDocuments({ payee: { $ne: '' } }), 0);
});

test('running the seed twice changes nothing', async () => {
  const count = await Transaction.countDocuments();
  assert.deepEqual(await seedPublishedData(), { seeded: false });
  assert.equal(await Transaction.countDocuments(), count);
});
