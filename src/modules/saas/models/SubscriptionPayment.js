const mongoose = require('mongoose');
const { createSchema, sub, userRef } = require('../../core/schema');

const GatewaySchema = sub({
  provider: { type: String, default: 'razorpay' },
  ref: { type: String, default: null },
  paymentId: { type: String, default: null },
  checkoutUrl: { type: String, default: null },
  expiresAt: { type: Date, default: null },
});

// Money paid by an organization to the platform for its plan.
const SubscriptionPaymentSchema = createSchema(
  {
    planCode: { type: String, required: true },
    billingCycle: { type: String, enum: ['MONTHLY', 'YEARLY'], required: true },
    listAmount: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    couponCode: { type: String, default: null },
    status: {
      type: String,
      enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'REFUNDED'],
      default: 'PENDING',
      index: true,
    },
    gateway: { type: GatewaySchema, default: () => ({}) },
    paidAt: { type: Date, default: null },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    invoiceNumber: { type: String, default: null },
    initiatedBy: userRef({ default: null }),
    failureReason: { type: String, default: '' },
  },
  { collection: 'saas_subscription_payments' },
);

SubscriptionPaymentSchema.index({ 'gateway.ref': 1 }, { unique: true, partialFilterExpression: { 'gateway.ref': { $type: 'string' } } });
SubscriptionPaymentSchema.index({ organizationId: 1, createdAt: -1 });

module.exports =
  mongoose.models.SubscriptionPayment ||
  mongoose.model('SubscriptionPayment', SubscriptionPaymentSchema);
