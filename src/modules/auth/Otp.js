const mongoose = require('mongoose');
const { createSchema } = require('../core/schema');

// Hashed one-time passwords with expiry and attempt counting. Rows expire
// out of the collection automatically.
const OtpSchema = createSchema(
  {
    phone: { type: String, required: true, index: true },
    purpose: { type: String, default: 'login' },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    ip: { type: String, default: '' },
  },
  { tenant: false, collection: 'auth_otps' },
);

OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
OtpSchema.index({ phone: 1, createdAt: -1 });

module.exports = mongoose.models.Otp || mongoose.model('Otp', OtpSchema);
