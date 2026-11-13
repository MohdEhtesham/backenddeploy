const crypto = require('crypto');

/** X-Request-Id: accept a sane client value or mint one; echo it back. */
const requestId = (req, res, next) => {
  const incoming = String(req.get('x-request-id') || '');
  req.requestId = /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

// NoSQL-injection hardening: drop object keys that start with `$` or
// contain `.` from body / query / params, so `?status[$ne]=x` or
// `{ "phone": { "$gt": "" } }` can never become a Mongo operator.
const clean = (value, depth = 0) => {
  if (depth > 20) return undefined;
  if (Array.isArray(value)) return value.map(v => clean(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.')) continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  }
  return value;
};

const sanitize = (req, _res, next) => {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) req.body = clean(req.body);
  if (req.query && typeof req.query === 'object') {
    const q = clean(req.query);
    for (const key of Object.keys(req.query)) delete req.query[key];
    Object.assign(req.query, q);
  }
  if (req.params && typeof req.params === 'object') req.params = clean(req.params);
  next();
};

/** Hash an IP for privacy-preserving storage (analytics). */
const hashIp = ip => crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 16);

module.exports = { requestId, sanitize, clean, hashIp };
