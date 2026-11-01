import mongoose from 'mongoose';

export const ROLES = { ADMIN: 'admin', FINANCE: 'finance_officer', HEAD: 'department_head' };

const toJSON = {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    delete ret._id;
    delete ret.passwordHash;
    return ret;
  },
};

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, enum: Object.values(ROLES) },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
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

export const User = mongoose.model('User', userSchema);
export const Department = mongoose.model('Department', departmentSchema);
