// The detection rules as pure functions: figures in, findings out. No database, so every rule is unit-testable.
import { daysBetween, fyBounds, positionAt } from './fy.js';
import { utilizationPct } from './money.js';

export const SEVERITIES = ['low', 'medium', 'high', 'critical'];
export const severityRank = (s) => SEVERITIES.indexOf(s);

export const ALERT_TYPES = {
  under_utilization: 'Under-utilization',
  pace_deviation: 'Pace deviation',
  overspending: 'Overspending',
  dormant: 'Dormant funds',
  year_end_rush: 'Year-end rush',
  possible_duplicate: 'Possible duplicate',
  spike: 'Spending spike',
};

export const DEFAULT_THRESHOLDS = {
  underUtilization: { minElapsedPct: 70, maxUtilizationPct: 40 },
  pace: { startElapsedPct: 25, maxGapPts: 15 },
  overspending: { warnPct: 90 },
  dormant: { days: 45, minRemainingPct: 25 },
  yearEndRush: { q4MaxPct: 33, marchMaxPct: 15 },
  duplicate: { windowDays: 7 },
  spike: { zLimit: 3.5, historyMonths: 24, minHistoryMonths: 6, singleTxnPct: 10 },
};

export function mergeThresholds(...layers) {
  const merged = structuredClone(DEFAULT_THRESHOLDS);
  for (const layer of layers) {
    for (const [rule, values] of Object.entries(layer ?? {})) Object.assign(merged[rule], values);
  }
  return merged;
}

const round2 = (n) => Math.round(n * 100) / 100;
const crore = (paise) => `Rs ${(paise / 1e9).toLocaleString('en-IN', { maximumFractionDigits: 2 })} crore`;
const rupees = (paise) => `Rs ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money = (paise) => (Math.abs(paise) >= 1e9 ? crore(paise) : rupees(paise));
// Distance past the threshold, in the rule's own units, decides how serious it is.
const bySize = (excess, [high, critical]) => (excess >= critical ? 'critical' : excess >= high ? 'high' : 'medium');

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * transactions: this budget's records in its financial year up to asOf, as
 *   { id, kind, amountPaise, date: 'YYYY-MM-DD', category, reversed }.
 * history: earlier months of the same series, as { month: 'YYYY-MM', amountPaise }.
 */
export function evaluate({ financialYear, allocatedPaise, asOf, transactions, history = [], thresholds = DEFAULT_THRESHOLDS }) {
  const t = thresholds;
  const findings = [];
  const add = (type, periodKey, severity, message, evidence) => findings.push({ type, periodKey, severity, message, evidence: { ...evidence, asOf } });
  const { q4, march, start } = fyBounds(financialYear);
  const spent = transactions.reduce((sum, x) => sum + x.amountPaise, 0);
  const util = utilizationPct(spent, allocatedPaise);
  const { elapsedPct } = positionAt(asOf);
  const base = { utilizationPct: util, elapsedPct, spentPaise: spent, allocatedPaise };

  const u = t.underUtilization;
  if (elapsedPct >= u.minElapsedPct && util < u.maxUtilizationPct) {
    add('under_utilization', 'year', bySize(u.maxUtilizationPct - util, [10, 20]),
      `${util}% used with ${elapsedPct}% of the year gone. The rule flags less than ${u.maxUtilizationPct}% used once ${u.minElapsedPct}% has passed.`,
      { ...base, ...u });
  }

  const gap = round2(util - elapsedPct);
  if (elapsedPct >= t.pace.startElapsedPct && util <= 100 && Math.abs(gap) > t.pace.maxGapPts) {
    const behind = gap < 0;
    const gapPaise = spent - Math.round((allocatedPaise * elapsedPct) / 100);
    add('pace_deviation', behind ? 'behind' : 'ahead', bySize(Math.abs(gap) - t.pace.maxGapPts, [10, 20]),
      `${Math.abs(gap)} points ${behind ? 'behind' : 'ahead of'} pace: ${util}% used with ${elapsedPct}% of the year gone, ${money(Math.abs(gapPaise))} ${behind ? 'unspent against' : 'over'} an even pace. The limit is ${t.pace.maxGapPts} points.`,
      { ...base, gapPts: gap, gapPaise, maxGapPts: t.pace.maxGapPts });
  }

  if (util >= t.overspending.warnPct) {
    const over = util > 100;
    add('overspending', 'year', over ? 'critical' : 'medium',
      over
        ? `${util}% of the allocation spent, ${money(spent - allocatedPaise)} over budget.`
        : `${util}% of the allocation spent, past the ${t.overspending.warnPct}% warning level.`,
      { ...base, warnPct: t.overspending.warnPct });
  }

  const lastSpend = transactions.filter((x) => x.amountPaise > 0).reduce((last, x) => (x.date > last ? x.date : last), '');
  const idleDays = daysBetween(lastSpend || start, asOf);
  const remainingPct = round2(100 - util);
  if (idleDays >= t.dormant.days && remainingPct > t.dormant.minRemainingPct) {
    add('dormant', `since-${lastSpend || 'start'}`, bySize(idleDays / t.dormant.days, [4 / 3, 2]),
      `No spending for ${idleDays} days${lastSpend ? ` since ${lastSpend}` : ' since the year began'}, with ${remainingPct}% of the allocation unspent.`,
      { ...base, idleDays, lastSpendDate: lastSpend || null, remainingPct, ...t.dormant });
  }

  if (asOf >= q4 && allocatedPaise > 0) {
    const share = (from) => round2((transactions.filter((x) => x.date >= from).reduce((s, x) => s + x.amountPaise, 0) / allocatedPaise) * 100);
    const q4Pct = share(q4);
    if (q4Pct > t.yearEndRush.q4MaxPct) {
      add('year_end_rush', 'q4', bySize(q4Pct - t.yearEndRush.q4MaxPct, [10, 20]),
        `${q4Pct}% of the allocation spent from January to March, above the ${t.yearEndRush.q4MaxPct}% ceiling.`,
        { ...base, q4Pct, q4MaxPct: t.yearEndRush.q4MaxPct });
    }
    const marchPct = asOf >= march ? share(march) : 0;
    if (marchPct > t.yearEndRush.marchMaxPct) {
      add('year_end_rush', 'march', marchPct - t.yearEndRush.marchMaxPct >= 10 ? 'critical' : 'high',
        `${marchPct}% of the allocation spent in March, above the ${t.yearEndRush.marchMaxPct}% ceiling.`,
        { ...base, marchPct, marchMaxPct: t.yearEndRush.marchMaxPct });
    }
  }

  // Sorting by amount and category puts candidate pairs next to each other.
  const expenses = transactions
    .filter((x) => x.kind === 'expense' && !x.reversed)
    .sort((a, b) => a.amountPaise - b.amountPaise || a.category.localeCompare(b.category) || a.date.localeCompare(b.date));
  for (let i = 1; i < expenses.length; i++) {
    const [a, b] = [expenses[i - 1], expenses[i]];
    if (a.amountPaise === b.amountPaise && a.category === b.category && daysBetween(a.date, b.date) <= t.duplicate.windowDays) {
      add('possible_duplicate', `${a.id}-${b.id}`, 'high',
        `Two ${a.category} expenses of ${money(a.amountPaise)}, on ${a.date} and ${b.date}. Check that this was not paid twice.`,
        { amountPaise: a.amountPaise, category: a.category, transactionIds: [a.id, b.id], dates: [a.date, b.date], windowDays: t.duplicate.windowDays });
    }
  }

  const s = t.spike;
  const current = new Map();
  for (const x of transactions) current.set(x.date.slice(0, 7), (current.get(x.date.slice(0, 7)) ?? 0) + x.amountPaise);
  const series = [...history.filter((h) => !current.has(h.month)).map((h) => [h.month, h.amountPaise]), ...current].sort(([a], [b]) => a.localeCompare(b));
  for (const [i, [month, amount]] of series.entries()) {
    // March is left to the year-end rush rule: on the published history it caused 15 of 36 spike alerts.
    if (month < start.slice(0, 7) || month.endsWith('-03')) continue;
    // Negative months are published adjustments, not spending, so they never set the baseline.
    const prior = series.slice(Math.max(0, i - s.historyMonths), i).map(([, v]) => v).filter((v) => v >= 0);
    if (prior.length < s.minHistoryMonths) continue;
    const med = median(prior);
    const mad = median(prior.map((v) => Math.abs(v - med)));
    if (mad === 0) continue;
    const z = round2((0.6745 * (amount - med)) / mad);
    if (z > s.zLimit) {
      add('spike', `month-${month}`, z >= 8 ? 'critical' : z >= 5 ? 'high' : 'medium',
        `${month} spending of ${money(amount)} is ${round2(amount / med)} times the usual month of ${money(Math.round(med))}. Modified z-score ${z}, limit ${s.zLimit}.`,
        { month, amountPaise: amount, medianPaise: Math.round(med), madPaise: Math.round(mad), z, zLimit: s.zLimit, historyMonths: prior.length });
    }
  }
  for (const x of transactions) {
    if (x.kind === 'expense' && !x.reversed && allocatedPaise > 0 && x.amountPaise > (allocatedPaise * s.singleTxnPct) / 100) {
      add('spike', `txn-${x.id}`, 'high',
        `A single expense of ${money(x.amountPaise)} on ${x.date} is ${round2((x.amountPaise / allocatedPaise) * 100)}% of the allocation, above the ${s.singleTxnPct}% limit.`,
        { transactionId: x.id, amountPaise: x.amountPaise, singleTxnPct: s.singleTxnPct });
    }
  }

  return findings;
}
