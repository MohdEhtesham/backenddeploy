const rateLimit = require('express-rate-limit');
const env = require('../../config/env');
const { tooMany } = require('./errors');

// Endpoint-specific limits layered under the global /api limiter.
const make = (max, windowMs, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => next(tooMany(message)),
  });

module.exports = {
  // Login / signup / OTP / refresh — brute force & SMS-pumping protection.
  authLimiter: make(
    env.AUTH_RATE_LIMIT_MAX,
    15 * 60 * 1000,
    'Too many sign-in attempts. Please wait a few minutes and try again.',
  ),
  // Online payment initiation.
  paymentLimiter: make(30, 60 * 1000, 'Too many payment requests. Please wait a moment.'),
  // File uploads.
  uploadLimiter: make(60, 15 * 60 * 1000, 'Too many uploads. Please try again later.'),
  // Anonymous analytics ingestion.
  analyticsLimiter: make(120, 60 * 1000, 'Too many analytics events.'),
};
