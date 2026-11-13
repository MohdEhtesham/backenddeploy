const AuditLog = require('./AuditLog');

const SENSITIVE = /pass(word)?|token|secret|otp|signature|idNumber|docNumber|authorization/i;

const redact = (value, depth = 0) => {
  if (value === null || value === undefined || depth > 6) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
};

/** Field-level before/after diff for the given keys. */
const diff = (before, after, fields) => {
  const out = {};
  for (const f of fields) {
    const a = before ? before[f] : undefined;
    const b = after ? after[f] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = { from: a, to: b };
  }
  return Object.keys(out).length ? out : null;
};

/**
 * Append an audit entry. Never throws — auditing must not break the
 * business action it records. `req` may be null for system actions.
 */
const audit = (req, { action, entityType = '', entityId = '', summary = '', changes = null, organizationId }) => {
  const ctx = (req && req.ctx) || {};
  const user = req && req.user;
  return AuditLog.create({
    organizationId: organizationId !== undefined ? organizationId : ctx.orgId || null,
    actorUserId: user ? user._id : null,
    actorName: user ? user.fullName : 'system',
    actorRole: ctx.role || (req && req.auth && req.auth.isSuperAdmin ? 'SUPER_ADMIN' : user ? user.role : 'SYSTEM'),
    action,
    entityType,
    entityId: entityId ? String(entityId) : '',
    summary,
    changes: redact(changes),
    ip: (req && req.ip) || '',
    userAgent: String((req && req.get && req.get('user-agent')) || '').slice(0, 300),
    requestId: (req && req.requestId) || '',
  }).catch(e => {
    console.warn('[audit] write failed', e.message);
    return null;
  });
};

module.exports = { audit, diff, redact };
