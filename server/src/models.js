import mongoose from 'mongoose';
import { utilizationPct } from './money.js';

export const ROLES = { ADMIN: 'admin', FINANCE: 'finance_officer', HEAD: 'department_head' };
export const CATEGORIES = ['Salaries', 'Subsidy', 'Interest', 'Capital works', 'Equipment', 'Travel', 'Grants', 'Services', 'Other'];

const { ObjectId } = mongoose.Schema.Types;

const toJSON = {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    delete ret._id;
    delete ret.passwordHash;
    return ret;
  },
};

const safeInteger = { validator: Number.isSafeInteger, message: 'Amount must be a whole number of paise' };
const WRITE_OPS = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'];

// Refuses changes at the model, so an append-only record stays one even if a route is added by mistake.
function appendOnly(schema) {
  schema.pre(WRITE_OPS, function () {
    throw new Error(`${this.model?.modelName ?? 'This collection'} is append-only`);
  });
  schema.pre('save', function () {
    if (!this.isNew) throw new Error('This record is append-only');
  });
}

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, enum: Object.values(ROLES) },
    departmentId: {
      type: ObjectId,
      ref: 'Department',
      default: null,
      required() {
        return this.role === ROLES.HEAD;
      },
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON },
);

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    sourceNote: { type: String, default: '' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON },
);

const budgetSchema = new mongoose.Schema(
  {
    financialYear: { type: String, required: true },
    departmentId: { type: ObjectId, ref: 'Department', required: true },
    // Empty for the department's own budget, which also carries the spending of its project budgets.
    project: { type: String, default: '', trim: true },
    allocatedPaise: { type: Number, required: true, min: 0, validate: safeInteger },
    quarterSplit: { type: [Number], default: undefined },
    spentPaise: { type: Number, default: 0, validate: safeInteger },
    sourceUrl: { type: String, default: '' },
    // Every allocation the budget has had, so any past date can be shown with the allocation in force then.
    revisions: [{ _id: false, date: { type: String, required: true }, allocatedPaise: { type: Number, required: true }, reason: { type: String, default: '' } }],
  },
  { timestamps: true, toJSON },
);
budgetSchema.methods.setAllocation = function (allocatedPaise, date, reason) {
  this.allocatedPaise = allocatedPaise;
  this.revisions.push({ date, allocatedPaise, reason });
};
budgetSchema.methods.allocationAt = function (date) {
  const before = this.revisions.filter((r) => r.date <= date);
  return (before.at(-1) ?? this.revisions[0])?.allocatedPaise ?? this.allocatedPaise;
};
budgetSchema.index({ financialYear: 1, departmentId: 1, project: 1 }, { unique: true });
budgetSchema.virtual('remainingPaise').get(function () {
  return this.allocatedPaise - this.spentPaise;
});
budgetSchema.virtual('utilizationPct').get(function () {
  return utilizationPct(this.spentPaise, this.allocatedPaise);
});

const transactionSchema = new mongoose.Schema(
  {
    kind: { type: String, required: true, enum: ['expense', 'reversal', 'monthly_summary'] },
    budgetId: { type: ObjectId, ref: 'Budget', required: true },
    departmentId: { type: ObjectId, ref: 'Department', required: true },
    financialYear: { type: String, required: true },
    // Negative only for reversals and published monthly figures that include adjustments.
    amountPaise: { type: Number, required: true, validate: safeInteger },
    category: { type: String, required: true, enum: CATEGORIES },
    date: { type: Date, required: true },
    description: { type: String, default: '', trim: true },
    payee: { type: String, default: '', trim: true },
    sourceUrl: { type: String, default: '' },
    reversesId: { type: ObjectId, ref: 'Transaction' },
    reason: { type: String, default: '' },
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, toJSON },
);
transactionSchema.index({ budgetId: 1, date: -1 });
transactionSchema.index({ departmentId: 1, date: -1 });
// A transaction can be reversed only once.
transactionSchema.index({ reversesId: 1 }, { unique: true, partialFilterExpression: { reversesId: { $exists: true } } });
appendOnly(transactionSchema);

const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: ObjectId, ref: 'User', default: null },
    actorName: { type: String, required: true },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: ObjectId, required: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    reason: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'at', updatedAt: false }, toJSON },
);
auditLogSchema.index({ entity: 1, entityId: 1, at: -1 });
auditLogSchema.index({ at: -1 });
appendOnly(auditLogSchema);

const alertSchema = new mongoose.Schema(
  {
    budgetId: { type: ObjectId, ref: 'Budget', required: true },
    departmentId: { type: ObjectId, ref: 'Department', required: true },
    financialYear: { type: String, required: true },
    type: { type: String, required: true },
    periodKey: { type: String, required: true },
    severity: { type: String, required: true, enum: ['low', 'medium', 'high', 'critical'] },
    severityRank: { type: Number, required: true },
    status: { type: String, default: 'open', enum: ['open', 'acknowledged', 'resolved'] },
    message: { type: String, required: true },
    // The figures and threshold at the moment it fired, so later edits cannot change why.
    evidence: { type: mongoose.Schema.Types.Mixed, required: true },
    detectedAt: { type: String, required: true },
    acknowledgedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    history: [{ _id: false, at: Date, action: String, severity: String, actorName: String, note: String }],
  },
  { timestamps: true, toJSON },
);
// One alert per problem: a repeat finding updates it instead of adding another.
alertSchema.index({ budgetId: 1, type: 1, periodKey: 1 }, { unique: true });
alertSchema.index({ departmentId: 1, financialYear: 1, status: 1 });

const thresholdSchema = new mongoose.Schema(
  {
    // null holds the global defaults; a department id holds that department's overrides.
    departmentId: { type: ObjectId, ref: 'Department', default: null },
    values: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, toJSON, minimize: false },
);
thresholdSchema.index({ departmentId: 1 }, { unique: true });

export const User = mongoose.model('User', userSchema);
export const Department = mongoose.model('Department', departmentSchema);
export const Budget = mongoose.model('Budget', budgetSchema);
export const Transaction = mongoose.model('Transaction', transactionSchema);
export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
export const Alert = mongoose.model('Alert', alertSchema);
export const Threshold = mongoose.model('Threshold', thresholdSchema);

// Collections must exist before the first transaction writes to them.
export const initModels = () => Promise.all([User, Department, Budget, Transaction, AuditLog, Alert, Threshold].map((m) => m.init()));
