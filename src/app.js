const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

const env = require('./config/env');
const { getStatus } = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { ok } = require('./utils/respond');

const authRoutes = require('./routes/auth.routes');
const propertyRoutes = require('./routes/property.routes');
const inquiryRoutes = require('./routes/inquiry.routes');
const visitRoutes = require('./routes/visit.routes');
const notificationRoutes = require('./routes/notification.routes');
const chatRoutes = require('./routes/chat.routes');
const sellerRoutes = require('./routes/seller.routes');
const adminRoutes = require('./routes/admin.routes');
const adminController = require('./controllers/admin.controller');
const uploadRoutes = require('./routes/upload.routes');

const { requestId, sanitize } = require('./modules/core/http');
const { mountDocs } = require('./modules/core/openapi');
const { mountModules } = require('./modules');
const { webhooksRouter, paymentsReturnRouter } = require('./modules/payments/webhooks.routes');
const wellKnownRoutes = require('./modules/wellKnown.routes');
const { registerLegacyDocs } = require('./modules/core/legacyDocs');

// ---------- DB-required routes (return 503 until DB connects) ----------
const requireDb = (_req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      message: 'Database is not connected yet. Please retry shortly.',
    });
  }
  next();
};

/**
 * Build the Express application (no listening, no DB connection) so it can
 * be booted by server.js and exercised directly by the test-suite.
 */
function createApp() {
  const app = express();

  // Render runs behind a proxy
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS.includes('*') ? true : env.CORS_ORIGINS,
      credentials: true,
    }),
  );

  // Payment webhooks need the raw body for signature verification, so they
  // are mounted before the JSON parser (and before the IP rate limiter —
  // gateway retries must never be throttled; the HMAC protects them).
  app.use('/api/webhooks', requireDb, webhooksRouter);

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(sanitize);
  if (env.NODE_ENV !== 'test') app.use(morgan('tiny'));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api', limiter);

  // ---------- Public endpoints (always available, even without DB) ----------

  app.get('/', (_req, res) =>
    ok(res, {
      name: 'Aabroo API',
      version: '1.0.0',
      db: mongoose.connection.readyState === 1 ? 'connected' : 'connecting',
    }),
  );

  app.get('/health', (_req, res) =>
    ok(res, {
      status: 'ok',
      db: mongoose.connection.readyState === 1 ? 'connected' : 'connecting',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }),
  );

  // Sanitized DB diagnostics (no URI / no password) — for production debugging
  app.get('/diagnostics', (_req, res) =>
    ok(res, {
      db: getStatus(),
      cloudinary: env.CLOUDINARY_ENABLED ? 'enabled' : 'disabled',
      nodeEnv: env.NODE_ENV,
      appEnv: env.APP_ENV,
      nodeVersion: process.version,
      uptime: process.uptime(),
    }),
  );

  app.use(wellKnownRoutes);

  if (env.API_DOCS_ENABLED) {
    registerLegacyDocs();
    mountDocs(app);
  }

  app.use('/api/auth', requireDb, authRoutes);
  app.use('/api/properties', requireDb, propertyRoutes);
  app.use('/api/inquiries', requireDb, inquiryRoutes);
  app.use('/api/visits', requireDb, visitRoutes);
  app.use('/api/notifications', requireDb, notificationRoutes);
  app.use('/api/chat', requireDb, chatRoutes);
  app.use('/api/seller', requireDb, sellerRoutes);
  // Public first-admin bootstrap, mounted before the auth-gated admin router
  // so no router-level middleware can intercept it. Self-disables once any
  // User has role='admin'.
  app.post('/api/admin/bootstrap', requireDb, adminController.bootstrap);
  app.use('/api/admin', requireDb, adminRoutes);
  app.use('/api/uploads', requireDb, uploadRoutes);

  // PG / Hostel SaaS + shared platform modules.
  app.use('/api/payments', requireDb, paymentsReturnRouter);
  mountModules(app, requireDb);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, requireDb };
