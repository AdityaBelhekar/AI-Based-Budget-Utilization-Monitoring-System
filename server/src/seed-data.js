import { readFileSync } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { writeAudit } from './audit.js';
import { parseCsvRecords } from './csv.js';
import { Budget, Department, Transaction, initModels } from './models.js';
import { croreToPaise } from './money.js';
import { recordTransactions } from './transactions.js';

export const SEED_FILE = path.resolve(import.meta.dirname, '../../data/cga-monthly.csv');

// CGA reports these as budget heads, not departments. The administering departments named here are our reading, not CGA's.
const HEADS = {
  FOOD: { name: 'Food Subsidy', category: 'Subsidy', note: 'CGA budget head. Administered by the Department of Food and Public Distribution (our mapping).' },
  NBS: { name: 'Nutrient Based Fertilizers Subsidy', category: 'Subsidy', note: 'CGA budget head. Administered by the Department of Fertilizers (our mapping).' },
  UREA: { name: 'Urea Subsidy', category: 'Subsidy', note: 'CGA budget head. Administered by the Department of Fertilizers (our mapping).' },
  PETROLEUM: { name: 'Petroleum Subsidy', category: 'Subsidy', note: 'CGA budget head. Administered by the Ministry of Petroleum and Natural Gas (our mapping).' },
  INTEREST: { name: 'Interest Payments', category: 'Interest', note: 'CGA budget head covering Union Government interest payments.' },
  CAPEX: { name: 'Capital Expenditure', category: 'Capital works', note: 'CGA budget head covering all Union Government capital expenditure, not a single department.' },
};

const lastDayOf = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0));
};

const readRows = () => parseCsvRecords(readFileSync(SEED_FILE, 'utf8')).records;

// Published figures are year-to-date, so each month's record is the difference from the month before.
export async function seedPublishedData() {
  await initModels();
  if (await Transaction.exists({ kind: 'monthly_summary' })) return { seeded: false };

  const rows = readRows();
  await mongoose.connection.transaction(async (session) => {
    const departments = {};
    for (const [code, head] of Object.entries(HEADS)) {
      const [department] = await Department.create([{ code, name: head.name, sourceNote: head.note }], { session });
      await writeAudit(session, null, { action: 'create', entity: 'department', entityId: department._id, after: department.toJSON() });
      departments[code] = department;
    }

    const budgets = new Map();
    const lastYtd = new Map();
    const docs = [];
    for (const row of rows) {
      const key = `${row.financial_year}|${row.head}`;
      const allocatedPaise = croreToPaise(row.budget_crore);
      let budget = budgets.get(key);
      if (!budget) {
        [budget] = await Budget.create(
          [{ financialYear: row.financial_year, departmentId: departments[row.head]._id, allocatedPaise, sourceUrl: row.source_url }],
          { session },
        );
        await writeAudit(session, null, { action: 'create', entity: 'budget', entityId: budget._id, after: budget.toJSON(), reason: `Budget Estimates, CGA statement for ${row.month}` });
        budgets.set(key, budget);
      } else if (budget.allocatedPaise !== allocatedPaise) {
        const before = budget.toJSON();
        budget.allocatedPaise = allocatedPaise;
        budget.sourceUrl = row.source_url;
        await budget.save({ session });
        await writeAudit(session, null, { action: 'update', entity: 'budget', entityId: budget._id, before, after: budget.toJSON(), reason: `${row.basis === 'RE' ? 'Revised Estimates' : 'Budget figure changed'} in CGA statement for ${row.month}` });
      }

      const ytd = croreToPaise(row.ytd_actual_crore);
      const amountPaise = ytd - (lastYtd.get(key) ?? 0);
      lastYtd.set(key, ytd);
      if (amountPaise === 0) continue;
      docs.push({
        kind: 'monthly_summary',
        budgetId: budget._id,
        departmentId: budget.departmentId,
        financialYear: row.financial_year,
        amountPaise,
        category: HEADS[row.head].category,
        date: lastDayOf(row.month),
        description: `${HEADS[row.head].name}, ${row.month}, from CGA monthly accounts (provisional)`,
        sourceUrl: row.source_url,
      });
    }
    await recordTransactions(session, null, docs, 'import');
    await assertReconciles(rows, session);
  });
  return { seeded: true, months: rows.length / Object.keys(HEADS).length };
}

// Every budget must end on exactly the last published allocation and year-to-date figure.
export async function assertReconciles(rows = readRows(), session = null) {
  const departments = await Department.find({ code: { $in: Object.keys(HEADS) } }).session(session);
  const lastByKey = new Map(rows.map((r) => [`${r.financial_year}|${r.head}`, r]));
  const mismatches = [];
  for (const [key, row] of lastByKey) {
    const department = departments.find((d) => d.code === row.head);
    const budget = await Budget.findOne({ financialYear: row.financial_year, departmentId: department._id, project: '' }).session(session);
    const [{ total = 0 } = {}] = await Transaction.aggregate([
      { $match: { budgetId: budget._id } },
      { $group: { _id: null, total: { $sum: '$amountPaise' } } },
    ]).session(session);
    const expected = croreToPaise(row.ytd_actual_crore);
    if (budget.spentPaise !== expected || total !== expected || budget.allocatedPaise !== croreToPaise(row.budget_crore)) {
      mismatches.push(`${key}: published ${expected}, budget ${budget.spentPaise}, ledger ${total}`);
    }
  }
  if (mismatches.length) throw new Error(`Seed does not reconcile:\n${mismatches.join('\n')}`);
  return lastByKey.size;
}

if (process.argv[1] === import.meta.filename) {
  await mongoose.connect(process.env.MONGODB_URI);
  const result = await seedPublishedData();
  console.log(result.seeded ? `Seeded ${result.months} months; totals reconcile` : 'Already seeded; nothing changed');
  await mongoose.disconnect();
}
