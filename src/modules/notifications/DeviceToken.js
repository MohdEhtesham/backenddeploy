const mongoose = require('mongoose');
const { createSchema, userRef } = require('../core/schema');

// Push registration tokens (FCM / APNs) per device. A token belongs to the
// last user who registered it — re-registering on another account moves it.
const DeviceTokenSchema = createSchema(
  {
    userId: userRef({ required: true, index: true }),
    token: { type: String, required: true, maxlength: 4096 },
    platform: { type: String, enum: ['ios', 'android', 'web'], required: true },
    provider: { type: String, enum: ['fcm', 'apns'], default: 'fcm' },
    appVersion: { type: String, default: '' },
    deviceId: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { tenant: false, collection: 'device_tokens' },
);

DeviceTokenSchema.index({ token: 1 }, { unique: true });

module.exports = mongoose.models.DeviceToken || mongoose.model('DeviceToken', DeviceTokenSchema);
