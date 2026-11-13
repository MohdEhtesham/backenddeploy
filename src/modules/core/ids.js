const { randomUUID } = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** v4 UUID used as `_id` for every PG / SaaS document. */
const uuid = () => randomUUID();

const isUuid = v => typeof v === 'string' && UUID_RE.test(v);

module.exports = { uuid, isUuid, UUID_RE };
