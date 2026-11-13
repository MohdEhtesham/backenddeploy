const mongoose = require('mongoose');
const { createSchema, sub, ref, userRef } = require('../../core/schema');

const METHODS = ['CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'ONLINE', 'DEPOSIT_ADJUSTMENT'];
const OFFLINE_METHODS = ['CASH', 'UPI', 'BANK_TRANSFER', 'CARD'];
const STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'];

const AllocationSchema = sub({
  invoiceId: ref('RentInvoice', { required: true }),
  amount: { type: Number, required: true, min: 0 },
  // PAYMENT = applied when received; CREDIT = applied later from advance.
  source: { type: String, enum: ['PAYMENT', 'CREDIT'], default: 'PAYMENT' },
  appliedAt: { type: Date, default: Date.now },
});

const GatewaySchema = sub({
  provider: { type: String, default: null },
  ref: { type: String, default: null },
  paymentId: { type: String, default: null },
  checkoutUrl: { type: String, default: null },
  expiresAt: { type: Date, default: null },
  lastStatus: { type: String, default: null },
});

// Money received from a tenant. Online payments start PENDING and become
// SUCCEEDED only after server-side verification with the gateway (signed
// webhook or server-to-server status check) — never from client input.
const PaymentSchema = createSchema(
  {
    receiptNumber: { type: String, default: null },
    tenantId: ref('Tenant', { required: true, index: true }),
    propertyId: ref('PgProperty', { default: null, index: true }),
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: METHODS, required: true },
    status: { type: String, enum: STATUSES, default: 'PENDING', index: true },
    allocations: { type: [AllocationSchema], default: [] },
    // Portion of this payment not yet applied to any invoice (advance).
    unappliedAmount: { type: Number, default: 0, min: 0 },
    refundedAmount: { type: Number, default: 0, min: 0 },
    // Invoices an online payment was initiated for.
    invoiceIds: [{ type: String }],
    reference: { type: String, trim: true, maxlength: 120, default: '' },
    paidAt: { type: Date, default: null, index: true },
    source: { type: String, enum: ['STAFF', 'TENANT_APP', 'SYSTEM'], default: 'STAFF' },
    recordedBy: userRef({ default: null }),
    gateway: { type: GatewaySchema, default: () => ({}) },
    idempotencyKey: { type: String, default: null },
    failureReason: { type: String, default: '' },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { collection: 'pg_payments', optimisticConcurrency: true },
);

PaymentSchema.index(
  { organizationId: 1, receiptNumber: 1 },
  { unique: true, partialFilterExpression: { receiptNumber: { $type: 'string' } } },
);
PaymentSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
PaymentSchema.index(
  { 'gateway.ref': 1 },
  { unique: true, partialFilterExpression: { 'gateway.ref': { $type: 'string' } } },
);
PaymentSchema.index({ organizationId: 1, tenantId: 1, unappliedAmount: 1 });

module.exports = mongoose.models.Payment || mongoose.model('Payment', PaymentSchema);
module.exports.METHODS = METHODS;
module.exports.OFFLINE_METHODS = OFFLINE_METHODS;
module.exports.STATUSES = STATUSES;
