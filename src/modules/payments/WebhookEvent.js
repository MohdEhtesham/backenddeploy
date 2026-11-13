const mongoose = require('mongoose');
const { createSchema } = require('../core/schema');

// Webhook idempotency ledger: one row per (provider, event id). A duplicate
// delivery hits the unique index and is acknowledged without reprocessing;
// a failed attempt is retried by the provider and re-claimed here.
const WebhookEventSchema = createSchema(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    event: { type: String, default: '' },
    status: {
      type: String,
      enum: ['PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED'],
      default: 'PROCESSING',
      index: true,
    },
    attempts: { type: Number, default: 1 },
    lockedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
    error: { type: String, default: '' },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { tenant: false, collection: 'payments_webhook_events' },
);

WebhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.models.WebhookEvent || mongoose.model('WebhookEvent', WebhookEventSchema);
