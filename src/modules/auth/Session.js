const mongoose = require('mongoose');
const { createSchema, userRef } = require('../core/schema');

// One row per signed-in device. The refresh token is `<sessionId>.<secret>`;
// only a SHA-256 of the secret is stored. Rotation keeps the previous hash
// so a replayed (stolen) token is detected and the session revoked.
const SessionSchema = createSchema(
  {
    userId: userRef({ required: true, index: true }),
    refreshTokenHash: { type: String, required: true },
    previousRefreshTokenHash: { type: String, default: null },
    rotatedAt: { type: Date, default: null },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    platform: { type: String, default: '' },
    lastUsedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: '' },
  },
  { tenant: false, collection: 'auth_sessions' },
);

// Expired sessions are purged automatically a week after expiry.
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

module.exports = mongoose.models.Session || mongoose.model('Session', SessionSchema);
