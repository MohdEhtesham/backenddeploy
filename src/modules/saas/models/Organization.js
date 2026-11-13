const mongoose = require('mongoose');
const { createSchema, sub, userRef, ACTIVE_ONLY } = require('../../core/schema');

const AddressSchema = sub({
  line1: { type: String, trim: true, default: '' },
  line2: { type: String, trim: true, default: '' },
  city: { type: String, trim: true, default: '' },
  state: { type: String, trim: true, default: '' },
  pincode: { type: String, trim: true, default: '' },
  country: { type: String, trim: true, default: 'India' },
});

const LateFeeSchema = sub({
  type: { type: String, enum: ['NONE', 'FLAT', 'PER_DAY'], default: 'NONE' },
  amount: { type: Number, default: 0, min: 0 },
  graceDays: { type: Number, default: 0, min: 0, max: 60 },
  maxAmount: { type: Number, default: 0, min: 0 },
});

const SettingsSchema = sub({
  timezone: { type: String, default: 'Asia/Kolkata' },
  currency: { type: String, default: 'INR' },
  billingDay: { type: Number, default: 1, min: 1, max: 28 },
  dueDays: { type: Number, default: 5, min: 0, max: 60 },
  lateFee: { type: LateFeeSchema, default: () => ({}) },
  noticePeriodDays: { type: Number, default: 30, min: 0, max: 180 },
  chargeNoticeShortfall: { type: Boolean, default: true },
  requireKycForCheckIn: { type: Boolean, default: false },
  rentReminderDaysBefore: { type: Number, default: 3, min: 0, max: 15 },
  invoicePrefix: { type: String, default: 'INV', maxlength: 8 },
  receiptPrefix: { type: String, default: 'RCPT', maxlength: 8 },
});

// The tenant boundary itself — not tenant-scoped.
const OrganizationSchema = createSchema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 140 },
    ownerUserId: userRef({ required: true, index: true }),
    legalName: { type: String, trim: true, default: '' },
    gstin: { type: String, trim: true, uppercase: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    logoUrl: { type: String, default: '' },
    address: { type: AddressSchema, default: () => ({}) },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE', index: true },
    suspendedReason: { type: String, default: '' },
    settings: { type: SettingsSchema, default: () => ({}) },
    // Internal notes, visible to super admins only.
    adminNotes: { type: String, default: '' },
  },
  { tenant: false, softDelete: true, collection: 'saas_organizations' },
);

OrganizationSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: ACTIVE_ONLY });
OrganizationSchema.index({ name: 'text' });

module.exports = mongoose.models.Organization || mongoose.model('Organization', OrganizationSchema);
