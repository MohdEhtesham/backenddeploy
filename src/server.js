// Catch any error that escapes the rest of the app — print, then exit.
// Without these, an unhandled rejection would silently crash with no log.
process.on('uncaughtException', err => {
  console.error('[fatal] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  console.error('[fatal] unhandledRejection:', reason);
  process.exit(1);
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

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

// Render / most PaaS hosts run behind a proxy. Trust it so req.ip etc work
// and rate-limit can read the X-Forwarded-For header.
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

app.get('/', (_req, res) => ok(res, { name: 'Aabroo API', version: '1.0.0' }));
app.get('/health', (_req, res) =>
  ok(res, { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() }),
);

app.use('/api/auth', authRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/inquiries', inquiryRoutes);
app.use('/api/visits', visitRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/uploads', uploadRoutes);

app.use(notFound);
app.use(errorHandler);

(async () => {
  console.log(`[server] starting (node ${process.version}, env ${env.NODE_ENV})`);

  try {
    await connectDB();
  } catch (err) {
    console.error('[server] DB connection failed:', err.message);
    process.exit(1);
  }

  // Render assigns PORT dynamically. Bind to 0.0.0.0 so external traffic reaches us.
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`[server] Aabroo API listening on :${env.PORT} (${env.NODE_ENV})`);
    console.log(`[server] health check: http://0.0.0.0:${env.PORT}/health`);
  });

  // listen() errors (port-in-use, permission denied, etc) emit on the server, not throw
  server.on('error', err => {
    console.error('[server] listen error:', err);
    process.exit(1);
  });

  // Graceful shutdown so DB connections close cleanly on Render redeploys
  const shutdown = signal => {
    console.log(`[server] received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();

module.exports = app;
