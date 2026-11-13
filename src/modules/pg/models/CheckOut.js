const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');

// Final settlement record. `settlement` keeps the full computed breakdown
// exactly as it was when the checkout was executed.
const CheckOutSchema = createSchema(
  {
    checkOutNumber: { type: String, required: true },
    tenantId: ref('Tenant', { required: true, index: true }),
    propertyId: ref('PgProperty', { required: true, index: true }),
    roomId: ref('Room', { required: true }),
    bedId: ref('Bed', { required: true }),
    allocationId: ref('BedAllocation', { required: true }),
    checkoutDate: { type: Date, required: true, index: true },
    reason: { type: String, trim: true, maxlength: 300, default: '' },
    settlement: { type: mongoose.Schema.Types.Mixed, required: true },
    settlementInvoiceId: ref('RentInvoice', { default: null }),
    depositAdjustmentPaymentId: ref('Payment', { default: null }),
    refundIds: [{ type: String }],
    amountDue: { type: Number, default: 0 },
    refundTotal: { type: Number, default: 0 },
    performedBy: userRef({ required: true }),
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { collection: 'pg_checkouts' },
);

CheckOutSchema.index({ organizationId: 1, checkOutNumber: 1 }, { unique: true });

module.exports = mongoose.models.CheckOut || mongoose.model('CheckOut', CheckOutSchema);
