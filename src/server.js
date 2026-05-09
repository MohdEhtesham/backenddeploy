// Catch any error that escapes the rest of the app — print, then exit.
process.on('uncaughtException', err => {
  console.error('[fatal] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  // Don't exit on unhandled rejection — log loudly instead. Exiting here
  // was masking the real error from a failed mongoose.connect on Render.
  console.error('[fatal] unhandledRejection:', reason);
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

const env = require('./config/env');
const { connectDB } = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { ok } = require('./utils/respond');

const authRoutes = require('./routes/auth.routes');
const propertyRoutes = require('./routes/property.routes');
const inquiryRoutes = require('./routes/inquiry.routes');
const visitRoutes = require('./routes/visit.routes');
const notificationRoutes = require('./routes/notification.routes');
const chatRoutes = require('./routes/chat.routes');
const sellerRoutes = require('./routes/seller.routes');
const uploadRoutes = require('./routes/upload.routes');

const app = express();

// Render runs behind a proxy
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGINS.includes('*') ? true : env.CORS_ORIGINS,
    credentials: true,
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
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

app.use('/api/auth', requireDb, authRoutes);
app.use('/api/properties', requireDb, propertyRoutes);
app.use('/api/inquiries', requireDb, inquiryRoutes);
app.use('/api/visits', requireDb, visitRoutes);
app.use('/api/notifications', requireDb, notificationRoutes);
app.use('/api/chat', requireDb, chatRoutes);
app.use('/api/seller', requireDb, sellerRoutes);
app.use('/api/uploads', requireDb, uploadRoutes);

app.use(notFound);
app.use(errorHandler);

// ---------- Boot order: LISTEN FIRST, CONNECT DB AFTER ----------
// Listening immediately means Render's port scan succeeds and the service
// goes "Live" even if DB connect is slow/failing. The actual DB error
// (if any) is logged loudly with full stack so you can debug.

console.log(`[server] starting (node ${process.version}, env ${env.NODE_ENV})`);

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`[server] Aabroo API listening on :${env.PORT} (${env.NODE_ENV})`);
  console.log(`[server] health check: /health`);
});

server.on('error', err => {
  console.error('[server] listen error:', err);
  process.exit(1);
});

// Now connect to DB in background. Errors are loud but non-fatal — the
// /health endpoint reports db status so you can see what's happening.
connectDB()
  .then(() => {
    console.log('[db] ✓ ready — all /api routes are now active');
  })
  .catch(err => {
    console.error('');
    console.error('[db] ============================================================');
    console.error('[db] CONNECTION FAILED');
    console.error('[db] name:    ', err?.name);
    console.error('[db] message: ', err?.message);
    console.error('[db] code:    ', err?.code);
    if (err?.codeName) console.error('[db] codeName:', err.codeName);
    if (err?.reason) console.error('[db] reason:  ', JSON.stringify(err.reason, null, 2));
    console.error('[db] stack:');
    console.error(err?.stack);
    console.error('[db] ============================================================');
    console.error('');
    console.error('Common fixes:');
    console.error('  1. MongoDB Atlas → Network Access → Add IP 0.0.0.0/0');
    console.error('  2. Verify username/password in MONGODB_URI (URL-encode special chars)');
    console.error('  3. Ensure cluster is not paused (Atlas pauses inactive M0 clusters)');
    console.error('  4. Check Atlas → Database Access → user has readWrite role');
    console.error('');
    console.error('Server is still running but /api/* will return 503 until DB connects.');
    console.error('Visit /health to see live db status.');
  });

// Graceful shutdown so DB connections close cleanly on Render redeploys
const shutdown = signal => {
  console.log(`[server] received ${signal}, shutting down`);
  server.close(() => {
    mongoose.connection.close(false).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
