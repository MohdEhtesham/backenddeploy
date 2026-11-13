const { z } = require('zod');
const { validation } = require('./errors');
const { round2 } = require('./money');
const { DAY_KEY_RE } = require('./dates');

// ---- Reusable field schemas -------------------------------------------------

const id = z.string().uuid('Invalid id');

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const dayKey = z
  .string()
  .regex(DAY_KEY_RE, 'Use YYYY-MM-DD')
  .refine(v => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), 'Invalid date');

const money = z.coerce
  .number({ invalid_type_error: 'Must be a number' })
  .min(0, 'Must be ≥ 0')
  .max(100000000, 'Amount too large')
  .transform(round2);

const positiveMoney = z.coerce
  .number({ invalid_type_error: 'Must be a number' })
  .gt(0, 'Must be greater than 0')
  .max(100000000, 'Amount too large')
  .transform(round2);

/** Indian mobile number; accepts +91 / 0 prefixes and spaces, stores 10 digits. */
const phone = z
  .string()
  .trim()
  .transform(v => v.replace(/[\s-]/g, '').replace(/^(\+?91|0)(?=\d{10}$)/, ''))
  .refine(v => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number');

const email = z.string().trim().toLowerCase().email('Invalid email').max(160);

const text = (max = 200) => z.string().trim().max(max);
const requiredText = (max = 200) => z.string().trim().min(1, 'Required').max(max);

const url = z.string().trim().url().max(1000);

const boolQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform(v => v === 'true' || v === '1');

const csvList = (item = z.string()) =>
  z
    .string()
    .max(1000)
    .transform(v => v.split(',').map(s => s.trim()).filter(Boolean))
    .pipe(z.array(item).max(50));

const pagination = {
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().max(40).regex(/^[-+]?[A-Za-z0-9_.]+$/, 'Invalid sort').optional(),
  q: z.string().max(100).optional(),
};

const listQuery = (extra = {}) => z.object({ ...pagination, ...extra });

const idParams = z.object({ id });

const dateRange = {
  from: dayKey.optional(),
  to: dayKey.optional(),
};

// ---- Middleware -------------------------------------------------------------

const formatIssues = issues =>
  (issues || []).map(i => ({ path: i.path.join('.'), message: i.message, code: i.code }));

/**
 * Validate req[source] against a Zod schema. Parsed (stripped, coerced)
 * values land in req.valid[source]; unknown keys never reach handlers, so
 * clients cannot smuggle fields such as organizationId or status.
 */
const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source] === undefined ? {} : req[source]);
  if (!result.success) return next(validation(formatIssues(result.error.issues)));
  req.valid = req.valid || {};
  req.valid[source] = result.data;
  next();
};

module.exports = {
  z,
  id,
  objectId,
  dayKey,
  money,
  positiveMoney,
  phone,
  email,
  text,
  requiredText,
  url,
  boolQuery,
  csvList,
  pagination,
  listQuery,
  idParams,
  dateRange,
  validate,
  formatIssues,
};
