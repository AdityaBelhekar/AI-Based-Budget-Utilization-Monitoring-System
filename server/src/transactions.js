import express, { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import { requireRole } from './auth.js';
import { parseCsvRecords } from './csv.js';
import { financialYearOf, isRealDate, todayInIndia } from './fy.js';
import { HttpError, canSeeDepartment, fyLabel, isHead, objectId, pageQuery, paginate, safePaise } from './http.js';
import { Budget, CATEGORIES, ROLES, Transaction } from './models.js';
import { rupeesToPaise } from './money.js';
import { scanAfterWrite } from './monitor.js';

const MAX_IMPORT_ROWS = 5000;
const IMPORT_COLUMNS = ['budget_id', 'date', 'amount_rupees', 'category', 'description', 'payee'];
// Vercel refuses request bodies over 4.5 MB, so the limit sits just under it.
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

const dateString = z.string().refine(isRealDate, 'Use a real date as YYYY-MM-DD');
const expenseFields = {
  budgetId: objectId,
  date: dateString,
  category: z.enum(CATEGORIES),
  description: z.string().trim().max(500).default(''),
  payee: z.string().trim().max(200).default(''),
};
const expenseCreate = z.object({ ...expenseFields, amountPaise: safePaise.positive() }).strict();
const reverseBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const transactionQuery = z.object({
  ...pageQuery,
  budgetId: objectId.optional(),
  departmentId: objectId.optional(),
  financialYear: fyLabel.optional(),
  category: z.enum(CATEGORIES).optional(),
  kind: z.enum(['expense', 'reversal', 'monthly_summary']).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});

const SIGNATURES = [
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];
export const sniffDocumentType = (buffer) =>
  SIGNATURES.find(({ bytes }) => bytes.every((b, i) => buffer[i] === b))?.type ?? null;

const documents = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'documents' });

// The one write path for spending: the record, the budget totals and the audit entry succeed or fail together.
export async function recordTransactions(session, actor, docs, action = 'create') {
  const inserted = await Transaction.insertMany(docs, { session });
  const changes = new Map();
  for (const t of inserted) {
    const key = t.budgetId.toString();
    changes.set(key, { budgetId: t.budgetId, amount: (changes.get(key)?.amount ?? 0) + t.amountPaise });
  }
  for (const { budgetId, amount } of changes.values()) {
    const budget = await Budget.findByIdAndUpdate(budgetId, { $inc: { spentPaise: amount } }, { session });
    // A department's own budget also carries what its project budgets spend.
    if (budget.project) {
      await Budget.updateOne(
        { financialYear: budget.financialYear, departmentId: budget.departmentId, project: '' },
        { $inc: { spentPaise: amount } },
        { session },
      );
    }
  }
  for (const t of inserted) {
    await writeAudit(session, actor, { action, entity: 'transaction', entityId: t._id, after: t.toJSON(), reason: t.reason });
  }
  return inserted;
}

async function findBudgetFor(user, budgetId, session) {
  const budget = await Budget.findById(budgetId).session(session ?? null);
  if (!budget || !canSeeDepartment(user, budget.departmentId)) throw new HttpError(404, 'Budget not found');
  return budget;
}

function buildExpense(fields, budget, user) {
  if (financialYearOf(fields.date) !== budget.financialYear) {
    throw new HttpError(400, `The date must fall in financial year ${budget.financialYear}`);
  }
  if (fields.date > todayInIndia()) throw new HttpError(400, 'The date cannot be in the future');
  return {
    ...fields,
    kind: 'expense',
    date: new Date(`${fields.date}T00:00:00Z`),
    departmentId: budget.departmentId,
    financialYear: budget.financialYear,
    createdBy: user._id,
  };
}

async function findScoped(req) {
  const transaction = await Transaction.findById(objectId.parse(req.params.id));
  if (!transaction || !canSeeDepartment(req.user, transaction.departmentId)) throw new HttpError(404, 'Not found');
  return transaction;
}

// One failing row rejects the whole file, so a partial import can never skew totals.
async function buildImport(text, user) {
  const { header, records } = parseCsvRecords(text);
  if (IMPORT_COLUMNS.some((c) => !header.includes(c))) {
    throw new HttpError(400, `The file needs these columns: ${IMPORT_COLUMNS.join(', ')}`);
  }
  if (!records.length) throw new HttpError(400, 'The file has no rows');
  if (records.length > MAX_IMPORT_ROWS) throw new HttpError(400, `The file has more than ${MAX_IMPORT_ROWS} rows`);

  const budgets = new Map();
  const docs = [];
  const errors = [];
  for (const [i, record] of records.entries()) {
    try {
      const fields = z.object(expenseFields).parse({
        budgetId: record.budget_id,
        date: record.date,
        category: record.category,
        description: record.description,
        payee: record.payee,
      });
      const amountPaise = rupeesToPaise(record.amount_rupees);
      if (amountPaise <= 0) throw new Error('The amount must be more than zero');
      if (!budgets.has(fields.budgetId)) budgets.set(fields.budgetId, await findBudgetFor(user, fields.budgetId));
      docs.push(buildExpense({ ...fields, amountPaise }, budgets.get(fields.budgetId), user));
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') : err.message;
      // Row 1 is the header, so the first data row is row 2 in the reader's spreadsheet.
      errors.push({ row: i + 2, message });
    }
  }
  if (errors.length) throw new HttpError(400, `${errors.length} of ${records.length} rows have errors; nothing was imported`, { rows: errors });
  return docs;
}

export function transactionRoutes() {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } });
  router.use(requireRole(ROLES.FINANCE, ROLES.HEAD));

  router.get('/', async (req, res) => {
    const { page, limit, from, to, ...filter } = transactionQuery.parse(req.query);
    if (isHead(req.user)) filter.departmentId = req.user.departmentId;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(`${from}T00:00:00Z`);
      if (to) filter.date.$lte = new Date(`${to}T00:00:00Z`);
    }
    res.json(await paginate(Transaction.find(filter).sort('-date -createdAt'), { page, limit }));
  });

  router.post('/', async (req, res) => {
    const body = expenseCreate.parse(req.body);
    const budget = await findBudgetFor(req.user, body.budgetId);
    const doc = buildExpense(body, budget, req.user);
    const [created] = await mongoose.connection.transaction((session) => recordTransactions(session, req.user, [doc]));
    await scanAfterWrite([created.budgetId]);
    res.status(201).json(created);
  });

  router.post('/import', express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }), async (req, res) => {
    if (typeof req.body !== 'string') throw new HttpError(400, 'Send the file as text/csv');
    const docs = await buildImport(req.body, req.user);
    await mongoose.connection.transaction((session) => recordTransactions(session, req.user, docs, 'import'));
    await scanAfterWrite([...new Set(docs.map((d) => d.budgetId.toString()))]);
    res.status(201).json({ imported: docs.length });
  });

  router.get('/:id', async (req, res) => res.json(await findScoped(req)));

  router.post('/:id/reverse', requireRole(ROLES.FINANCE), async (req, res) => {
    const { reason } = reverseBody.parse(req.body);
    const original = await findScoped(req);
    if (original.kind !== 'expense') throw new HttpError(400, 'Only an expense can be reversed');
    const doc = {
      kind: 'reversal',
      budgetId: original.budgetId,
      departmentId: original.departmentId,
      financialYear: original.financialYear,
      amountPaise: -original.amountPaise,
      category: original.category,
      // Keeps the original's date, so its month's total is corrected rather than a later month's.
      date: original.date,
      description: original.description,
      payee: original.payee,
      reversesId: original._id,
      reason,
      createdBy: req.user._id,
    };
    const [reversal] = await mongoose.connection.transaction((session) => recordTransactions(session, req.user, [doc], 'reverse')).catch((err) => {
      throw err.code === 11000 ? new HttpError(409, 'This transaction has already been reversed') : err;
    });
    await scanAfterWrite([reversal.budgetId]);
    res.status(201).json(reversal);
  });

  router.get('/:id/documents', async (req, res) => {
    const transaction = await findScoped(req);
    const files = await documents().find({ 'metadata.transactionId': transaction._id }).sort({ uploadDate: -1 }).toArray();
    res.json(files.map((f) => ({ id: f._id, name: f.filename, size: f.length, type: f.metadata.contentType, uploadedAt: f.uploadDate })));
  });

  router.post('/:id/documents', upload.single('file'), async (req, res) => {
    const transaction = await findScoped(req);
    if (!req.file) throw new HttpError(400, 'Attach a file in the "file" field');
    const contentType = sniffDocumentType(req.file.buffer);
    if (!contentType) throw new HttpError(415, 'Only PDF, JPG and PNG files are accepted');
    const name = req.file.originalname.replace(/[^\w.\- ]/g, '_').slice(0, 120);
    const stream = documents().openUploadStream(name, {
      metadata: { transactionId: transaction._id, departmentId: transaction.departmentId, contentType, uploadedBy: req.user._id },
    });
    await new Promise((resolve, reject) => stream.on('finish', resolve).on('error', reject).end(req.file.buffer));
    await writeAudit(null, req.user, { action: 'attach', entity: 'transaction', entityId: transaction._id, after: { documentId: stream.id, name } });
    res.status(201).json({ id: stream.id, name, size: req.file.size, type: contentType });
  });

  return router;
}

export function documentRoutes() {
  const router = Router();
  router.use(requireRole(ROLES.FINANCE, ROLES.HEAD));

  router.get('/:id', async (req, res) => {
    const id = new mongoose.Types.ObjectId(objectId.parse(req.params.id));
    const [file] = await documents().find({ _id: id }).toArray();
    if (!file || !canSeeDepartment(req.user, file.metadata.departmentId)) throw new HttpError(404, 'Not found');
    res.type(file.metadata.contentType).attachment(file.filename);
    documents().openDownloadStream(id).on('error', (err) => res.destroy(err)).pipe(res);
  });

  return router;
}
