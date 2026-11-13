const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');

const RefundSchema = createSchema(
  {
    refundNumber: { type: String, required: true },
    tenantId: ref('Tenant', { required: true, index: true }),
    paymentId: ref('Payment', { default: null }),
    checkOutId: ref('CheckOut', { default: null }),
    type: { type: String, enum: ['DEPOSIT_REFUND', 'ADVANCE_REFUND', 'PAYMENT_REFUND'], required: true },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'CANCELLED'],
      default: 'PENDING',
      index: true,
    },
    method: { type: String, enum: ['CASH', 'UPI', 'BANK_TRANSFER', 'GATEWAY', null], default: null },
    reference: { type: String, trim: true, maxlength: 120, default: '' },
    reason: { type: String, trim: true, maxlength: 300, default: '' },
    gatewayRefundId: { type: String, default: null },
    processedBy: userRef({ default: null }),
    processedAt: { type: Date, default: null },
    createdBy: userRef({ default: null }),
  },
  { collection: 'pg_refunds' },
);

RefundSchema.index({ organizationId: 1, refundNumber: 1 }, { unique: true });

module.exports = mongoose.models.Refund || mongoose.model('Refund', RefundSchema);
