const mongoose = require('mongoose');
const { createSchema, sub, userRef } = require('../../core/schema');

const STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED', 'SUSPENDED'];

const HistorySchema = sub({
  at: { type: Date, default: Date.now },
  event: { type: String, required: true },
  fromStatus: String,
  toStatus: String,
  fromPlan: String,
  toPlan: String,
  byUserId: userRef({ default: null }),
  note: String,
});

// One subscription row per organization. Status transitions happen only on
// the server (payment webhooks, lifecycle job, super admin actions).
const SubscriptionSchema = createSchema(
  {
    planCode: { type: String, required: true, uppercase: true },
    status: { type: String, enum: STATUSES, required: true, index: true },
    billingCycle: { type: String, enum: ['MONTHLY', 'YEARLY'], default: 'MONTHLY' },
    trialEndsAt: { type: Date, default: null },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null, index: true },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    pastDueSince: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    suspendedReason: { type: String, default: '' },
    // Per-organization grants on top of the plan (e.g. +100 beds).
    entitlementOverrides: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ limits: {}, features: {} }),
    },
    couponCode: { type: String, default: null },
    lastPaymentId: { type: String, default: null },
    // Idempotency keys of expiry / renewal reminders already sent.
    remindersSent: [{ type: String }],
    history: { type: [HistorySchema], default: [] },
  },
  { collection: 'saas_subscriptions', tenantIndex: false },
);

SubscriptionSchema.index({ organizationId: 1 }, { unique: true });

SubscriptionSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.models.Subscription || mongoose.model('Subscription', SubscriptionSchema);
