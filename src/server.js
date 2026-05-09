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
  try {
    await connectDB();
    app.listen(env.PORT, () => {
      console.log(`[server] Aabroo API listening on :${env.PORT} (${env.NODE_ENV})`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
})();

module.exports = app;
