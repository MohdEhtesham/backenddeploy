const mongoose = require('mongoose');

// Key/value platform configuration editable by the super admin
// (trial length, grace period, default trial plan, …). Env vars only
// provide the initial defaults.
const PlatformSettingSchema = new mongoose.Schema(
  {
    _id: { type: String },
    value: { type: mongoose.Schema.Types.Mixed },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'saas_platform_settings', timestamps: true, versionKey: false },
);

module.exports =
  mongoose.models.PlatformSetting || mongoose.model('PlatformSetting', PlatformSettingSchema);
