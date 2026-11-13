const mongoose = require('mongoose');
const { createSchema, ACTIVE_ONLY } = require('../../core/schema');

const CouponSchema = createSchema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 32 },
    description: { type: String, default: '' },
    type: { type: String, enum: ['PERCENT', 'FLAT'], required: true },
    value: { type: Number, required: true, min: 0 },
    maxRedemptions: { type: Number, default: 0, min: 0 }, // 0 = unlimited
    redemptions: { type: Number, default: 0, min: 0 },
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    planCodes: [{ type: String, uppercase: true }], // empty = all plans
    billingCycles: [{ type: String, enum: ['MONTHLY', 'YEARLY'] }], // empty = both
    active: { type: Boolean, default: true },
  },
  { tenant: false, softDelete: true, collection: 'saas_coupons' },
);

CouponSchema.index({ code: 1 }, { unique: true, partialFilterExpression: ACTIVE_ONLY });

module.exports = mongoose.models.Coupon || mongoose.model('Coupon', CouponSchema);
