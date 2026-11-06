import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { positionRows, resolveView } from './dashboard.js';
import { ALERT_TYPES } from './detection.js';
import { HttpError, isHead, objectId } from './http.js';
import { Alert, Department, Transaction } from './models.js';

const MAX_LEDGER_ROWS = 20000;
const reportQuery = z.object({ format: z.enum(['csv', 'pdf', 'json']).default('json'), departmentId: objectId.optional() });

const crore = (paise) => (paise / 1e9).toFixed(2);
const rupees = (paise) => (paise / 100).toFixed(2);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const day = (date) => `${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
const STATUS = { behind: 'Behind pace', ahead: 'Ahead of pace', on: 'On pace', over: 'Over budget' };

// A spreadsheet runs a cell starting with = + - @ as a formula, so text cells get a leading quote.
export function csvCell(value) {
  if (typeof value === 'number') return String(value);
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const toCsv = (columns, rows) => [columns.map((c) => csvCell(c.label)).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(','))].join('\r\n') + '\r\n';

const REPORTS = {
  async utilization(user, view) {
    const rows = await positionRows(user, view);
    return {
      title: `Budget utilization at ${day(view.asOf)}`,
      columns: [
        { key: 'department', label: 'Budget head', width: 150 },
        { key: 'allocated', label: 'Allocated (Rs crore)', width: 80, align: 'right' },
        { key: 'spent', label: 'Spent (Rs crore)', width: 80, align: 'right' },
        { key: 'remaining', label: 'Remaining (Rs crore)', width: 80, align: 'right' },
        { key: 'utilization', label: 'Used (%)', width: 55, align: 'right' },
        { key: 'gap', label: 'Gap (points)', width: 55, align: 'right' },
        { key: 'status', label: 'Status', width: 70 },
        { key: 'alerts', label: 'Open alerts', width: 50, align: 'right' },
      ],
      rows: rows.map((r) => ({
        department: r.departmentName,
        allocated: Number(crore(r.allocatedPaise)),
        spent: Number(crore(r.spentPaise)),
        remaining: Number(crore(r.remainingPaise)),
        utilization: r.utilizationPct,
        gap: r.gapPts,
        status: STATUS[r.status],
        alerts: r.openAlerts,
      })),
      note: `Elapsed: ${view.elapsedPct}% of the year (day ${view.dayOfYear} of ${view.daysInYear}). Published figures are CGA provisional accounts.`,
    };
  },

  async transactions(user, view, { departmentId }) {
    const filter = { financialYear: view.financialYear, date: { $lte: new Date(`${view.asOf}T00:00:00Z`) } };
    if (departmentId) filter.departmentId = departmentId;
    if (isHead(user)) filter.departmentId = user.departmentId;
    const [records, departments] = await Promise.all([
      Transaction.find(filter).sort('date createdAt').limit(MAX_LEDGER_ROWS).lean(),
      Department.find().lean(),
    ]);
    const names = new Map(departments.map((d) => [d._id.toString(), d.name]));
    return {
      title: `Expenditure ledger to ${day(view.asOf)}`,
      columns: [
        { key: 'date', label: 'Date', width: 60 },
        { key: 'department', label: 'Budget head', width: 120 },
        { key: 'kind', label: 'Type', width: 70 },
        { key: 'category', label: 'Category', width: 65 },
        { key: 'amount', label: 'Amount (Rs)', width: 95, align: 'right' },
        { key: 'description', label: 'Description', width: 210 },
      ],
      rows: records.map((t) => ({
        date: t.date.toISOString().slice(0, 10),
        department: names.get(t.departmentId.toString()) ?? '',
        kind: { expense: 'Expense', reversal: 'Reversal', monthly_summary: 'Published month' }[t.kind],
        category: t.category,
        amount: Number(rupees(t.amountPaise)),
        description: t.description,
      })),
      note: records.length === MAX_LEDGER_ROWS ? `Limited to the first ${MAX_LEDGER_ROWS} records.` : `${records.length} records.`,
    };
  },

  async alerts(user, view) {
    const filter = { financialYear: view.financialYear };
    if (isHead(user)) filter.departmentId = user.departmentId;
    const alerts = await Alert.find(filter).sort({ severityRank: -1, detectedAt: -1 }).populate('departmentId', 'name').lean();
    return {
      title: `Alerts raised in ${view.financialYear}`,
      columns: [
        { key: 'detected', label: 'Detected', width: 60 },
        { key: 'department', label: 'Budget head', width: 110 },
        { key: 'type', label: 'Rule', width: 80 },
        { key: 'severity', label: 'Severity', width: 50 },
        { key: 'status', label: 'Status', width: 70 },
        { key: 'message', label: 'Finding', width: 250 },
      ],
      rows: alerts.map((a) => ({ detected: a.detectedAt, department: a.departmentId?.name ?? '', type: ALERT_TYPES[a.type], severity: a.severity, status: a.status, message: a.message })),
      note: `${alerts.length} alerts.`,
    };
  },
};

function sendPdf(res, report, filename, generatedBy) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  res.type('application/pdf').attachment(`${filename}.pdf`);
  doc.pipe(res);
  doc.font('Helvetica-Bold').fontSize(14).text(report.title);
  doc.font('Helvetica').fontSize(9).fillColor('#525A66').text(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by ${generatedBy}. ${report.note}`);
  doc.moveDown(0.8).fillColor('#14181F');
  const row = (cells, bold) => {
    const y = doc.y;
    let x = doc.page.margins.left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    const height = Math.max(...report.columns.map((c, i) => doc.heightOfString(String(cells[i] ?? ''), { width: c.width - 6 })));
    if (y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      return row(cells, bold);
    }
    report.columns.forEach((c, i) => {
      doc.text(String(cells[i] ?? ''), x, y, { width: c.width - 6, align: c.align ?? 'left' });
      x += c.width;
    });
    doc.y = y + height + 4;
    doc.x = doc.page.margins.left;
  };
  row(report.columns.map((c) => c.label), true);
  for (const r of report.rows) row(report.columns.map((c) => (typeof r[c.key] === 'number' ? r[c.key].toLocaleString('en-IN', { minimumFractionDigits: c.label.includes('Rs') ? 2 : 0 }) : r[c.key])));
  doc.end();
}

export function reportRoutes() {
  const router = Router();

  router.get('/:type', async (req, res) => {
    const build = Object.hasOwn(REPORTS, req.params.type) ? REPORTS[req.params.type] : null;
    if (!build) throw new HttpError(404, 'Unknown report');
    const { format, departmentId } = reportQuery.parse({ format: req.query.format, departmentId: req.query.departmentId });
    const view = await resolveView(req.user, { financialYear: req.query.financialYear, month: req.query.month });
    const report = await build(req.user, view, { departmentId });
    const filename = `${req.params.type}-${view.financialYear}-${view.asOf}`;
    if (format === 'csv') return res.type('text/csv').attachment(`${filename}.csv`).send(toCsv(report.columns, report.rows));
    if (format === 'pdf') return sendPdf(res, report, filename, req.user.name);
    res.json({ ...report, view });
  });

  return router;
}
