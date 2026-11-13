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

const mongoose = require('mongoose');

const env = require('./config/env');
const { connectDB } = require('./config/db');
const { createApp } = require('./app');
const { attachSignaling } = require('./sockets/signaling');
const { attachChatSockets } = require('./sockets/chat');
const { seedRbac } = require('./modules/saas/services/rbac');
const { seedPlans } = require('./modules/saas/services/plans');
const { detectTransactionSupport } = require('./modules/core/tx');
const { startScheduler, stopScheduler } = require('./modules/jobs/scheduler');
const { flush: flushNotifications } = require('./modules/notifications/dispatcher');

const app = createApp();

// ---------- Boot order: LISTEN FIRST, CONNECT DB AFTER ----------
// Listening immediately means Render's port scan succeeds and the service
// goes "Live" even if DB connect is slow/failing. The actual DB error
// (if any) is logged loudly with full stack so you can debug.

console.log(`[server] starting (node ${process.version}, env ${env.NODE_ENV})`);

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`[server] Aabroo API listening on :${env.PORT} (${env.NODE_ENV})`);
  console.log(`[server] health check: /health`);
});

// Mount the WebRTC signaling namespace on the same HTTP server. It does
// not require DB to be ready; the join handler short-circuits with a
// proper error if the visit lookup fails before Mongo is up.
try {
  attachSignaling(server);
  console.log('[signaling] /visit-call namespace ready');
} catch (e) {
  console.error('[signaling] failed to attach', e);
}
try {
  attachChatSockets(server);
  console.log('[chat] /chat namespace ready');
} catch (e) {
  console.error('[chat] failed to attach', e);
}

server.on('error', err => {
  console.error('[server] listen error:', err);
  process.exit(1);
});

// Now connect to DB in background. Errors are loud but non-fatal — the
// /health endpoint reports db status so you can see what's happening.
connectDB()
  .then(async () => {
    console.log('[db] ✓ ready — all /api routes are now active');
    // Idempotent platform bootstrap: RBAC catalog, default plans,
    // transaction capability, then the background job scheduler.
    try {
      await seedRbac();
      await seedPlans();
      await detectTransactionSupport();
      console.log('[saas] RBAC + plans ready');
    } catch (e) {
      console.error('[saas] bootstrap failed', e);
    }
    startScheduler();
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
  stopScheduler();
  server.close(() => {
    flushNotifications()
      .catch(() => {})
      .finally(() => mongoose.connection.close(false).finally(() => process.exit(0)));
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
