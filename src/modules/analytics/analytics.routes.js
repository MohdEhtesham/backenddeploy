const { createRouter } = require('../core/router');
const { z, text } = require('../core/validation');
const AnalyticsEvent = require('./AnalyticsEvent');
const { EVENTS, sanitizeProps, actorHash } = require('./track');
const { analyticsLimiter } = require('../core/rateLimits');

// Client product-usage events (batched). The app only sends when the user
// has not opted out; the server drops PII-looking props and never stores
// IP addresses.
const r = createRouter({ prefix: '/analytics', tag: 'Analytics' });

const EventDto = z.object({
  name: z.enum(EVENTS),
  module: z.enum(['property', 'pg', 'platform']).default('platform'),
  props: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  occurredAt: z.string().datetime().optional(),
  anonymousId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
});

const BatchDto = z.object({
  events: z.array(EventDto).min(1).max(50),
  platform: z.enum(['ios', 'android', 'web']).optional(),
  appVersion: text(20).optional(),
});

r.post('/events', { auth: 'optional', body: BatchDto, middleware: [analyticsLimiter], success: 202, summary: 'Ingest product-usage events' }, async req => {
  const b = req.valid.body;
  const now = Date.now();
  const docs = b.events.map(e => {
    const at = e.occurredAt ? new Date(e.occurredAt).getTime() : now;
    return {
      name: e.name,
      module: e.module,
      props: sanitizeProps(e.props),
      anonymousId: e.anonymousId || '',
      actorHash: req.user ? actorHash(req.user._id) : '',
      platform: b.platform || '',
      appVersion: b.appVersion || '',
      source: 'client',
      // Clamp client clocks to a sane window.
      occurredAt: new Date(Math.min(now, Math.max(now - 7 * 24 * 3600 * 1000, at))),
      receivedAt: new Date(now),
    };
  });
  await AnalyticsEvent.insertMany(docs, { ordered: false });
  return { accepted: docs.length };
});

module.exports = r.router;
