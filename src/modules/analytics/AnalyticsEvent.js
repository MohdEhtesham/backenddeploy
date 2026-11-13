const mongoose = require('mongoose');
const env = require('../../config/env');
const { createSchema } = require('../core/schema');

// Product-usage events. Privacy by design: no names / phones / emails /
// IPs; the actor is a salted hash; rows expire after the retention window.
const AnalyticsEventSchema = createSchema(
  {
    name: { type: String, required: true, index: true },
    actorHash: { type: String, default: '' },
    anonymousId: { type: String, default: '' },
    organizationId: { type: String, default: null, index: true },
    module: { type: String, enum: ['property', 'pg', 'platform'], default: 'platform' },
    platform: { type: String, default: '' },
    appVersion: { type: String, default: '' },
    source: { type: String, enum: ['client', 'server'], default: 'client' },
    props: { type: mongoose.Schema.Types.Mixed, default: {} },
    occurredAt: { type: Date, default: Date.now },
    receivedAt: { type: Date, default: Date.now },
  },
  { tenant: false, collection: 'analytics_events', timestamps: false },
);

AnalyticsEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: env.ANALYTICS_RETENTION_DAYS * 24 * 3600 });
AnalyticsEventSchema.index({ name: 1, occurredAt: -1 });

module.exports = mongoose.models.AnalyticsEvent || mongoose.model('AnalyticsEvent', AnalyticsEventSchema);
