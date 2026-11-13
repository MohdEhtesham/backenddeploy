const mongoose = require('mongoose');
const { createSchema } = require('../../core/schema');

// Platform feature flags. Effective value for an org:
//   disabledOrgIds ∋ org → false; enabledOrgIds ∋ org → true; else `enabled`.
const FeatureFlagSchema = createSchema(
  {
    key: { type: String, required: true, trim: true, maxlength: 64 },
    description: { type: String, default: '' },
    enabled: { type: Boolean, default: false },
    enabledOrgIds: [{ type: String }],
    disabledOrgIds: [{ type: String }],
  },
  { tenant: false, collection: 'saas_feature_flags' },
);

FeatureFlagSchema.index({ key: 1 }, { unique: true });

module.exports = mongoose.models.FeatureFlag || mongoose.model('FeatureFlag', FeatureFlagSchema);
