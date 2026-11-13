const crypto = require('crypto');
const env = require('../../config/env');
const AnalyticsEvent = require('./AnalyticsEvent');

const EVENTS = [
  'product_selected',
  'property_viewed',
  'pg_dashboard_viewed',
  'tenant_created',
  'payment_initiated',
  'payment_completed',
  'complaint_created',
  'subscription_started',
  'subscription_upgraded',
  'screen_viewed',
];

const PII_KEY = /name|phone|mobile|email|address|dob|aadhaar|pan|passport|token|password|otp/i;

/** Keep only small scalar props with non-identifying keys. */
const sanitizeProps = props => {
  const out = {};
  if (!props || typeof props !== 'object') return out;
  for (const [k, v] of Object.entries(props).slice(0, 20)) {
    if (PII_KEY.test(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 80);
  }
  return out;
};

const actorHash = userId =>
  userId
    ? crypto.createHmac('sha256', `${env.JWT_SECRET}:analytics`).update(String(userId)).digest('hex').slice(0, 24)
    : '';

/** Server-side tracking for events the client must not be trusted with. */
const track = (name, { userId = null, organizationId = null, module = 'pg', props = {} } = {}) => {
  if (!EVENTS.includes(name)) return Promise.resolve(null);
  return AnalyticsEvent.create({
    name,
    actorHash: actorHash(userId),
    organizationId,
    module,
    platform: 'server',
    source: 'server',
    props: sanitizeProps(props),
  }).catch(e => {
    console.warn('[analytics] track failed', e.message);
    return null;
  });
};

module.exports = { EVENTS, track, sanitizeProps, actorHash };
