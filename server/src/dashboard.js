import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { financialYearOf, fyBounds, fyMonths, monthEnd, positionAt, todayInIndia } from './fy.js';
import { HttpError, canSeeDepartment, fyLabel, isHead, objectId } from './http.js';
import { Alert, Budget, Department, Transaction } from './models.js';
import { loadThresholds } from './monitor.js';
import { utilizationPct } from './money.js';

const MAX_PIE_SLICES = 5;
const viewQuery = z.object({ financialYear: fyLabel.optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional() });
const toDate = (iso) => new Date(`${iso}T00:00:00Z`);
const round2 = (n) => Math.round(n * 100) / 100;

const scopeFilter = (user) => (isHead(user) ? { departmentId: user.departmentId } : {});

/**
 * The year and the date being looked at. Defaults to the latest month CGA has published,
 * because judging published heads at today would show every one of them as behind.
 */
export async function resolveView(user, query) {
  const { financialYear: fy, month } = viewQuery.parse(query);
  const today = todayInIndia();
  const financialYear = fy ?? financialYearOf(today);
  const months = fyMonths(financialYear);
  if (month && !months.includes(month)) throw new HttpError(400, `${month} is not in financial year ${financialYear}`);
  const [latest] = await Transaction.find({ financialYear, kind: 'monthly_summary', ...scopeFilter(user) }).sort('-date').limit(1).lean();
  const publishedThrough = latest ? latest.date.toISOString().slice(0, 7) : null;
  const { end } = fyBounds(financialYear);
  const fallback = today < end ? today.slice(0, 7) : months.at(-1);
  const chosen = month ?? publishedThrough ?? fallback;
  const asOf = [monthEnd(chosen), today, end].sort()[0];
  return {
    financialYear,
    month: chosen,
    asOf,
    publishedThrough,
    months: months.map((m) => ({ month: m, available: `${m}-01` <= today, published: Boolean(publishedThrough && m <= publishedThrough) })),
    ...positionAt(asOf),
  };
}

// One row per department budget, judged at view.asOf. Reports reuse this, so screen and files always agree.
export async function positionRows(user, view) {
  const budgets = await Budget.find({ financialYear: view.financialYear, project: '', ...scopeFilter(user) }).populate('departmentId', 'name code sourceNote');
  if (!budgets.length) return [];
  const ids = budgets.map((b) => b.departmentId._id);
  const [spent, alerts, thresholds] = await Promise.all([
    Transaction.aggregate([
      { $match: { financialYear: view.financialYear, departmentId: { $in: ids }, date: { $lte: toDate(view.asOf) } } },
      { $group: { _id: '$departmentId', total: { $sum: '$amountPaise' } } },
    ]),
    Alert.aggregate([
      { $match: { financialYear: view.financialYear, departmentId: { $in: ids }, status: { $ne: 'resolved' } } },
      { $group: { _id: '$departmentId', count: { $sum: 1 }, worst: { $max: '$severityRank' } } },
    ]),
    loadThresholds(),
  ]);
  const spentBy = new Map(spent.map((s) => [s._id.toString(), s.total]));
  const alertsBy = new Map(alerts.map((a) => [a._id.toString(), a]));
  return budgets.map((b) => {
    const dept = b.departmentId;
    const allocatedPaise = b.allocationAt(view.asOf);
    const spentPaise = spentBy.get(dept._id.toString()) ?? 0;
    const util = utilizationPct(spentPaise, allocatedPaise);
    const gapPts = round2(util - view.elapsedPct);
    const limit = thresholds.for(dept._id).pace.maxGapPts;
    const status = util > 100 ? 'over' : gapPts < -limit ? 'behind' : gapPts > limit ? 'ahead' : 'on';
    return {
      budgetId: b.id,
      departmentId: dept.id,
      departmentName: dept.name,
      departmentCode: dept.code,
      sourceNote: dept.sourceNote,
      sourceUrl: b.sourceUrl,
      allocatedPaise,
      spentPaise,
      remainingPaise: allocatedPaise - spentPaise,
      utilizationPct: util,
      elapsedPct: view.elapsedPct,
      gapPts,
      gapPaise: spentPaise - Math.round((allocatedPaise * view.dayOfYear) / view.daysInYear),
      paceLimitPts: limit,
      status,
      openAlerts: alertsBy.get(dept._id.toString())?.count ?? 0,
    };
  });
}

async function monthlyTotals(match) {
  const rows = await Transaction.aggregate([
    { $match: match },
    { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, total: { $sum: '$amountPaise' } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.total]));
}

async function categoryShares(match) {
  const rows = await Transaction.aggregate([{ $match: match }, { $group: { _id: '$category', total: { $sum: '$amountPaise' } } }, { $sort: { total: -1 } }]);
  const positive = rows.filter((r) => r.total > 0);
  const top = positive.slice(0, MAX_PIE_SLICES - 1).map((r) => ({ category: r._id, amountPaise: r.total }));
  const rest = positive.slice(MAX_PIE_SLICES - 1).reduce((s, r) => s + r.total, 0);
  if (rest > 0) top.push({ category: 'Other', amountPaise: rest });
  return top;
}

export function dashboardRoutes() {
  const router = Router();

  router.get('/summary', async (req, res) => {
    const view = await resolveView(req.user, req.query);
    const rows = await positionRows(req.user, view);
    rows.sort((a, b) => Math.abs(b.gapPts) - Math.abs(a.gapPts));
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    const totals = { allocatedPaise: sum('allocatedPaise'), spentPaise: sum('spentPaise') };
    totals.utilizationPct = utilizationPct(totals.spentPaise, totals.allocatedPaise);
    res.json({ ...view, rows, totals });
  });

  router.get('/trend', async (req, res) => {
    const view = await resolveView(req.user, req.query);
    const departmentId = req.query.departmentId ? objectId.parse(req.query.departmentId) : null;
    if (departmentId && !canSeeDepartment(req.user, departmentId)) throw new HttpError(404, 'Not found');
    const scope = departmentId ? { departmentId: new mongoose.Types.ObjectId(departmentId) } : scopeFilter(req.user);
    const budgets = await Budget.find({ financialYear: view.financialYear, project: '', ...scope });
    const totals = await monthlyTotals({ financialYear: view.financialYear, ...scope, date: { $lte: toDate(view.asOf) } });
    let cumulative = 0;
    const months = fyMonths(view.financialYear)
      .filter((m) => m <= view.month)
      .map((month) => {
        const at = [monthEnd(month), view.asOf].sort()[0];
        cumulative += totals.get(month) ?? 0;
        const allocatedPaise = budgets.reduce((s, b) => s + b.allocationAt(at), 0);
        const { dayOfYear, daysInYear } = positionAt(at);
        return { month, spentPaise: totals.get(month) ?? 0, cumulativePaise: cumulative, allocatedPaise, pacePaise: Math.round((allocatedPaise * dayOfYear) / daysInYear) };
      });
    res.json({ financialYear: view.financialYear, months });
  });

  router.get('/categories', async (req, res) => {
    const view = await resolveView(req.user, req.query);
    const slices = await categoryShares({ financialYear: view.financialYear, ...scopeFilter(req.user), date: { $lte: toDate(view.asOf) } });
    res.json({ financialYear: view.financialYear, asOf: view.asOf, slices, totalPaise: slices.reduce((s, x) => s + x.amountPaise, 0) });
  });

  router.get('/departments/:id', async (req, res) => {
    const id = objectId.parse(req.params.id);
    if (!canSeeDepartment(req.user, id)) throw new HttpError(404, 'Not found');
    const department = await Department.findById(id);
    if (!department) throw new HttpError(404, 'Not found');
    // Judged as if scoped to this one department, whoever is asking.
    const asDepartment = { role: 'department_head', departmentId: department._id };
    const view = await resolveView(asDepartment, req.query);
    const [row] = await positionRows(asDepartment, view);
    const deptId = department._id;
    const [projects, totals, alerts, spikes] = await Promise.all([
      Budget.find({ financialYear: view.financialYear, departmentId: deptId, project: { $ne: '' } }).sort('project'),
      monthlyTotals({ financialYear: view.financialYear, departmentId: deptId, date: { $lte: toDate(view.asOf) } }),
      Alert.find({ financialYear: view.financialYear, departmentId: deptId, status: { $ne: 'resolved' } }).sort({ severityRank: -1, detectedAt: -1 }).limit(50),
      Alert.find({ financialYear: view.financialYear, departmentId: deptId, type: 'spike', periodKey: /^month-/ }, 'periodKey severity'),
    ]);
    const spikeMonths = new Map(spikes.map((s) => [s.periodKey.slice(6), s.severity]));
    res.json({
      ...view,
      department,
      position: row ?? null,
      projects: projects.map((p) => ({ budgetId: p.id, project: p.project, allocatedPaise: p.allocatedPaise, spentPaise: p.spentPaise, utilizationPct: utilizationPct(p.spentPaise, p.allocatedPaise) })),
      monthly: fyMonths(view.financialYear)
        .filter((m) => m <= view.month)
        .map((month) => ({ month, amountPaise: totals.get(month) ?? 0, spike: spikeMonths.get(month) ?? null })),
      alerts,
    });
  });

  // The brief's KPIs, computed from the records rather than typed in.
  router.get('/kpis', async (req, res) => {
    const scope = scopeFilter(req.user);
    const [byType, responded, budgets] = await Promise.all([
      Alert.aggregate([{ $match: scope }, { $group: { _id: '$type', count: { $sum: 1 } } }]),
      Alert.find({ ...scope, acknowledgedAt: { $ne: null } }, 'createdAt acknowledgedAt').lean(),
      Budget.find({ project: '', ...scope }).lean(),
    ]);
    const hours = responded.map((a) => (a.acknowledgedAt - a.createdAt) / 36e5).sort((a, b) => a - b);
    const medianResponseHours = hours.length ? round2(hours.length % 2 ? hours[hours.length >> 1] : (hours[hours.length / 2 - 1] + hours[hours.length / 2]) / 2) : null;

    // Of the money left unspent at year end, how much had an under-use warning before the last quarter began?
    const today = todayInIndia();
    const closed = budgets.filter((b) => fyBounds(b.financialYear).end < today);
    const early = await Alert.find(
      { ...scope, financialYear: { $in: [...new Set(closed.map((b) => b.financialYear))] }, $or: [{ type: 'under_utilization' }, { type: 'dormant' }, { type: 'pace_deviation', periodKey: 'behind' }] },
      'budgetId financialYear detectedAt',
    ).lean();
    let unspentPaise = 0;
    let flaggedPaise = 0;
    for (const b of closed) {
      const unspent = b.allocatedPaise - b.spentPaise;
      if (unspent <= 0) continue;
      unspentPaise += unspent;
      const q4 = fyBounds(b.financialYear).q4;
      if (early.some((a) => a.budgetId.toString() === b._id.toString() && a.detectedAt < q4)) flaggedPaise += unspent;
    }
    res.json({
      alertsByType: Object.fromEntries(byType.map((t) => [t._id, t.count])),
      medianResponseHours,
      respondedAlerts: hours.length,
      unspentAtYearEnd: { unspentPaise, flaggedBeforeQ4Paise: flaggedPaise, sharePct: unspentPaise ? round2((flaggedPaise / unspentPaise) * 100) : null, years: [...new Set(closed.map((b) => b.financialYear))].sort() },
    });
  });

  return router;
}
