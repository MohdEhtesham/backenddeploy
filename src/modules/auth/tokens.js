const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../../config/env');
const User = require('../../models/User');
const Session = require('./Session');
const { unauthorized } = require('../core/errors');

const DAY_MS = 24 * 60 * 60 * 1000;
const REUSE_GRACE_MS = 30 * 1000;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const newSecret = () => crypto.randomBytes(48).toString('base64url');

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

/**
 * Clients that implement silent refresh send `X-Auth-Mode: refresh` and get
 * short-lived access tokens. Legacy clients (older app builds, admin web)
 * keep the long-lived token they were built for.
 */
const wantsRefreshMode = req => String((req && req.get && req.get('x-auth-mode')) || '').toLowerCase() === 'refresh';

const signAccessToken = (user, sessionId, refreshMode) => {
  const token = jwt.sign(
    { sub: String(user._id), role: user.role, sid: sessionId },
    env.JWT_SECRET,
    { expiresIn: refreshMode ? env.ACCESS_TOKEN_TTL : env.JWT_EXPIRES_IN },
  );
  const { exp } = jwt.decode(token);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
};

const clientMeta = req => ({
  userAgent: String((req && req.get && req.get('user-agent')) || '').slice(0, 300),
  ip: String((req && req.ip) || ''),
  platform: String((req && req.get && req.get('x-client-platform')) || '').slice(0, 20),
});

/** Create a session for a freshly authenticated user. */
const issueSession = async (user, req) => {
  const secret = newSecret();
  const now = Date.now();
  const absolute = now + env.SESSION_MAX_AGE_DAYS * DAY_MS;
  const session = await Session.create({
    userId: user._id,
    refreshTokenHash: sha256(secret),
    expiresAt: new Date(Math.min(now + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS, absolute)),
    absoluteExpiresAt: new Date(absolute),
    ...clientMeta(req),
  });
  const access = signAccessToken(user, session._id, wantsRefreshMode(req));
  return {
    token: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: `${session._id}.${secret}`,
    sessionId: session._id,
  };
};

/** Exchange a refresh token for a new access + refresh token pair. */
const rotateRefreshToken = async refreshToken => {
  const raw = String(refreshToken || '');
  const dot = raw.indexOf('.');
  const sessionId = dot > 0 ? raw.slice(0, dot) : '';
  const secret = dot > 0 ? raw.slice(dot + 1) : '';
  if (!sessionId || !secret) throw unauthorized('Invalid refresh token', 'REFRESH_TOKEN_INVALID');

  const session = await Session.findById(sessionId);
  if (!session || session.revokedAt) throw unauthorized('Your session has ended. Please sign in again.', 'SESSION_REVOKED');
  const now = new Date();
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now) {
    throw unauthorized('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
  }

  const hash = sha256(secret);
  if (!safeEqual(hash, session.refreshTokenHash)) {
    if (session.previousRefreshTokenHash && safeEqual(hash, session.previousRefreshTokenHash)) {
      // A rotated-out token came back. Within a few seconds this is a benign
      // client race; later it means the token was copied → end the session.
      if (session.rotatedAt && now - session.rotatedAt < REUSE_GRACE_MS) {
        throw unauthorized('Token refresh already in progress', 'REFRESH_TOKEN_STALE');
      }
      await revokeSession(session._id, 'refresh_token_reuse');
      throw unauthorized('Your session was ended for security reasons. Please sign in again.', 'REFRESH_TOKEN_REUSED');
    }
    throw unauthorized('Invalid refresh token', 'REFRESH_TOKEN_INVALID');
  }

  const next = newSecret();
  // Conditional update → two concurrent refreshes can't both rotate.
  const updated = await Session.findOneAndUpdate(
    { _id: session._id, refreshTokenHash: hash, revokedAt: null },
    {
      $set: {
        refreshTokenHash: sha256(next),
        previousRefreshTokenHash: hash,
        rotatedAt: now,
        lastUsedAt: now,
        expiresAt: new Date(Math.min(now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS, session.absoluteExpiresAt.getTime())),
      },
    },
    { new: true },
  );
  if (!updated) throw unauthorized('Token refresh already in progress', 'REFRESH_TOKEN_STALE');

  const user = await User.findById(session.userId);
  if (!user || user.suspended) {
    await revokeSession(session._id, user ? 'suspended' : 'user_deleted');
    throw unauthorized('Account unavailable', 'SESSION_REVOKED');
  }
  const access = signAccessToken(user, session._id, true);
  return {
    user,
    token: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: `${session._id}.${next}`,
    sessionId: session._id,
  };
};

const revokeSession = (sessionId, reason = 'logout') =>
  Session.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });

const revokeAllSessions = (userId, reason = 'logout_all', exceptSessionId = null) =>
  Session.updateMany(
    { userId, revokedAt: null, ...(exceptSessionId ? { _id: { $ne: exceptSessionId } } : {}) },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );

/** Access tokens that carry a session id are only valid while it is. */
const isSessionActive = async (sessionId, userId) => {
  const s = await Session.findOne({ _id: sessionId }).select('userId revokedAt absoluteExpiresAt').lean();
  if (!s || s.revokedAt) return false;
  if (userId && String(s.userId) !== String(userId)) return false;
  return s.absoluteExpiresAt > new Date();
};

const listSessions = userId =>
  Session.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastUsedAt: -1 })
    .select('userAgent ip platform lastUsedAt createdAt expiresAt')
    .lean();

module.exports = {
  wantsRefreshMode,
  signAccessToken,
  issueSession,
  rotateRefreshToken,
  revokeSession,
  revokeAllSessions,
  isSessionActive,
  listSessions,
  sha256,
  safeEqual,
};
