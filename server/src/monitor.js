// Runs the detection rules against the database and keeps one alert per problem.
import { evaluate, mergeThresholds, severityRank } from './detection.js';
import { financialYearOf, fyBounds, fyMonths, monthEnd, todayInIndia } from './fy.js';
import { Alert, Budget, Threshold, Transaction } from './models.js';

const isoDate = (d) => d.toISOString().slice(0, 10);

// override = { departmentId: id or null, values } swaps in candidate thresholds without saving them.
export async function loadThresholds(override) {
  const docs = await Threshold.find().lean();
  const byDepartment = new Map(docs.filter((d) => d.departmentId).map((d) => [d.departmentId.toString(), d.values]));
  let global = docs.find((d) => !d.departmentId)?.values;
  if (override && !override.departmentId) global = override.values;
  if (override?.departmentId) byDepartment.set(override.departmentId.toString(), override.values);
  return { for: (departmentId) => mergeThresholds(global, byDepartment.get(departmentId.toString())) };
}

// Published figures arrive about a month late, so a budget fed by them is judged at its last published month.
function dataAsOf(budget, records, today) {
  const { end } = fyBounds(budget.financialYear);
  const published = records.filter((r) => r.kind === 'monthly_summary').reduce((last, r) => (r.date > last ? r.date : last), '');
  return published || (today < end ? today : end);
}

/**
 * Checks budgets and returns their findings. With persist, raises new alerts and escalates worse ones.
 * asOf replays a past date; override swaps in candidate thresholds for a preview.
 */
export async function scan({ filter = { financialYear: financialYearOf(todayInIndia()) }, asOf, override, persist = true } = {}) {
  const budgets = await Budget.find(filter);
  if (!budgets.length) return { budgetsChecked: 0, findings: [], raised: 0, escalated: 0 };
  const thresholds = await loadThresholds(override);
  const departmentIds = [...new Set(budgets.map((b) => b.departmentId.toString()))];
  const records = await Transaction.find({ departmentId: { $in: departmentIds } }, 'kind budgetId departmentId financialYear amountPaise category date reversesId').lean();
  const reversed = new Set(records.filter((r) => r.reversesId).map((r) => r.reversesId.toString()));
  const rows = records.map((r) => ({
    id: r._id.toString(),
    kind: r.kind,
    budgetId: r.budgetId.toString(),
    departmentId: r.departmentId.toString(),
    financialYear: r.financialYear,
    amountPaise: r.amountPaise,
    category: r.category,
    date: isoDate(r.date),
    reversed: reversed.has(r._id.toString()),
  }));
  const today = todayInIndia();

  const results = [];
  for (const budget of budgets) {
    const dept = budget.departmentId.toString();
    // A department's own budget carries its projects' spending, so it is judged on all of the department's records.
    const own = rows.filter((r) => r.financialYear === budget.financialYear && (budget.project ? r.budgetId === budget.id : r.departmentId === dept));
    const at = asOf ?? dataAsOf(budget, own, today);
    if (at < fyBounds(budget.financialYear).start) continue;
    const history = [];
    if (!budget.project) {
      const totals = new Map();
      for (const r of rows) if (r.departmentId === dept && r.financialYear < budget.financialYear) totals.set(r.date.slice(0, 7), (totals.get(r.date.slice(0, 7)) ?? 0) + r.amountPaise);
      for (const [month, amountPaise] of totals) history.push({ month, amountPaise });
    }
    const findings = evaluate({
      financialYear: budget.financialYear,
      allocatedPaise: budget.allocationAt(at),
      asOf: at,
      transactions: own.filter((r) => r.date <= at),
      events: own,
      history,
      thresholds: thresholds.for(dept),
    });
    results.push(...findings.map((f) => ({ ...f, budget, asOf: at })));
  }

  let raised = 0;
  let escalated = 0;
  if (persist) {
    for (const f of results) {
      const outcome = await saveFinding(f);
      if (outcome === 'raised') raised++;
      if (outcome === 'escalated') escalated++;
    }
  }
  return { budgetsChecked: budgets.length, findings: results, raised, escalated };
}

async function saveFinding({ budget, type, periodKey, severity, message, evidence, detectedAt }) {
  const key = { budgetId: budget._id, type, periodKey };
  const existing = await Alert.findOne(key);
  if (!existing) {
    try {
      await Alert.create({
        ...key,
        departmentId: budget.departmentId,
        financialYear: budget.financialYear,
        severity,
        severityRank: severityRank(severity),
        message,
        evidence,
        detectedAt,
        history: [{ at: new Date(), action: 'raised', severity }],
      });
      return 'raised';
    } catch (err) {
      if (err.code === 11000) return 'unchanged'; // Raised by a concurrent scan.
      throw err;
    }
  }
  // A resolved alert stays resolved; an open one only ever gets more serious.
  if (existing.status === 'resolved' || severityRank(severity) <= existing.severityRank) return 'unchanged';
  existing.set({ severity, severityRank: severityRank(severity), message, evidence });
  existing.history.push({ at: new Date(), action: 'escalated', severity });
  await existing.save();
  return 'escalated';
}

// After a write the money is safe; a detection failure is logged and caught by the next daily scan.
export async function scanAfterWrite(budgetIds) {
  try {
    const budgets = await Budget.find({ _id: { $in: budgetIds } }, 'financialYear departmentId project');
    const filter = { $or: budgets.map((b) => ({ financialYear: b.financialYear, departmentId: b.departmentId, project: { $in: ['', b.project] } })) };
    if (budgets.length) await scan({ filter });
  } catch (err) {
    console.error('Detection after write failed', err);
  }
}

// Replays every published month, so history shows when each problem would first have been flagged.
export async function replayPublishedHistory() {
  const years = await Budget.distinct('financialYear');
  const today = todayInIndia();
  let raised = 0;
  for (const financialYear of years.sort()) {
    for (const month of fyMonths(financialYear)) {
      const asOf = monthEnd(month);
      if (asOf > today) break;
      const hasData = await Transaction.exists({ financialYear, kind: 'monthly_summary', date: new Date(`${asOf}T00:00:00Z`) });
      if (!hasData) continue;
      raised += (await scan({ filter: { financialYear }, asOf })).raised;
    }
  }
  return raised;
}

