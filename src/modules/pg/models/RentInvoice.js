const mongoose = require('mongoose');
const { createSchema, sub, ref, userRef } = require('../../core/schema');
const { LINE_TYPES } = require('../services/billing');

const INVOICE_STATUSES = ['PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'];
const INVOICE_KINDS = ['RENT', 'DEPOSIT', 'SETTLEMENT', 'ADHOC'];

const LineSchema = sub({
  type: { type: String, enum: LINE_TYPES, required: true },
  description: { type: String, trim: true, maxlength: 200, default: '' },
  amount: { type: Number, required: true },
});

const RentInvoiceSchema = createSchema(
  {
    invoiceNumber: { type: String, required: true },
    tenantId: ref('Tenant', { required: true, index: true }),
    propertyId: ref('PgProperty', { required: true, index: true }),
    rentId: ref('Rent', { default: null }),
    kind: { type: String, enum: INVOICE_KINDS, required: true, index: true },
    periodKey: { type: String, default: null, index: true },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    // `${rentId}:${periodKey}` for live RENT invoices, null otherwise —
    // the unique index makes monthly generation idempotent while still
    // allowing a cancelled period to be re-issued.
    periodLock: { type: String, default: null },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true, index: true },
    lines: { type: [LineSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    total: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, default: 0, min: 0 },
    balance: { type: Number, default: 0 },
    status: { type: String, enum: INVOICE_STATUSES, default: 'PENDING', index: true },
    lateFeeAppliedAt: { type: Date, default: null },
    lateFeeWaived: { type: Boolean, default: false },
    remindedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: userRef({ default: null }),
    cancelReason: { type: String, trim: true, maxlength: 300, default: '' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    createdBy: userRef({ default: null }),
  },
  { collection: 'pg_invoices', optimisticConcurrency: true },
);

RentInvoiceSchema.index({ organizationId: 1, invoiceNumber: 1 }, { unique: true });
RentInvoiceSchema.index(
  { organizationId: 1, periodLock: 1 },
  { unique: true, partialFilterExpression: { periodLock: { $type: 'string' } }, name: 'one_rent_invoice_per_period' },
);
RentInvoiceSchema.index({ organizationId: 1, status: 1, dueDate: 1 });

module.exports = mongoose.models.RentInvoice || mongoose.model('RentInvoice', RentInvoiceSchema);
module.exports.INVOICE_STATUSES = INVOICE_STATUSES;
module.exports.INVOICE_KINDS = INVOICE_KINDS;
