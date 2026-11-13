const mongoose = require('mongoose');
const { createSchema, ACTIVE_ONLY } = require('../../core/schema');

// Plans and their entitlements are DATA (editable by the super admin), not
// code. `limits` values: a number, or -1 for unlimited. `features` values:
// booleans keyed by feature name.
const SubscriptionPlanSchema = createSchema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 32 },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    tagline: { type: String, default: '', maxlength: 140 },
    description: { type: String, default: '', maxlength: 1000 },
    currency: { type: String, default: 'INR' },
    priceMonthly: { type: Number, required: true, min: 0 },
    priceYearly: { type: Number, required: true, min: 0 },
    trialDays: { type: Number, default: null, min: 0, max: 365 },
    limits: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    features: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    isPublic: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    highlight: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
  },
  { tenant: false, softDelete: true, collection: 'saas_plans' },
);

SubscriptionPlanSchema.index({ code: 1 }, { unique: true, partialFilterExpression: ACTIVE_ONLY });

module.exports =
  mongoose.models.SubscriptionPlan || mongoose.model('SubscriptionPlan', SubscriptionPlanSchema);
