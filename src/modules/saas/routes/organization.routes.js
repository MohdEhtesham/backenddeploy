const { createRouter } = require('../../core/router');
const { z, text, phone, email, listQuery, dateRange } = require('../../core/validation');
const Organization = require('../models/Organization');
const AuditLog = require('../../core/AuditLog');
const { usage, getState } = require('../services/entitlements');
const { LIMIT_KEYS } = require('../services/plans');
const { listOptions, paginate } = require('../../core/query');
const { audit, diff } = require('../../core/audit');
const { publicDoc } = require('../../core/schema');
const D = require('../../core/dates');

const r = createRouter({ prefix: '/pg/organization', tag: 'Organization' });

const AddressDto = z.object({
  line1: text(200).optional(),
  line2: text(200).optional(),
  city: text(60).optional(),
  state: text(60).optional(),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Invalid pincode').optional().or(z.literal('')),
  country: text(60).optional(),
});

const UpdateOrgDto = z.object({
  name: text(120).min(2).optional(),
  legalName: text(160).optional(),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, 'Invalid GSTIN').optional().or(z.literal('')),
  email: email.optional().or(z.literal('')),
  phone: phone.optional().or(z.literal('')),
  logoUrl: z.string().trim().url().max(1000).optional().or(z.literal('')),
  address: AddressDto.optional(),
});

const SettingsDto = z.object({
  timezone: z.string().max(60).refine(tz => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone').optional(),
  billingDay: z.coerce.number().int().min(1).max(28).optional(),
  dueDays: z.coerce.number().int().min(0).max(60).optional(),
  lateFee: z
    .object({
      type: z.enum(['NONE', 'FLAT', 'PER_DAY']),
      amount: z.coerce.number().min(0).max(100000),
      graceDays: z.coerce.number().int().min(0).max(60).default(0),
      maxAmount: z.coerce.number().min(0).max(1000000).default(0),
    })
    .optional(),
  noticePeriodDays: z.coerce.number().int().min(0).max(180).optional(),
  chargeNoticeShortfall: z.boolean().optional(),
  requireKycForCheckIn: z.boolean().optional(),
  rentReminderDaysBefore: z.coerce.number().int().min(0).max(15).optional(),
  invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, '2–8 letters/digits').optional(),
  receiptPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, '2–8 letters/digits').optional(),
});

r.get('/', { permission: 'org.read', summary: 'Current organization' }, async req => {
  const org = await Organization.findById(req.ctx.orgId).lean();
  const { adminNotes, ...rest } = publicDoc(org);
  void adminNotes;
  return rest;
});

r.put('/', { permission: 'org.update', body: UpdateOrgDto, summary: 'Update organization profile' }, async req => {
  const org = await Organization.findById(req.ctx.orgId);
  const before = org.toJSON();
  const body = req.valid.body;
  if (body.address) body.address = { ...before.address, ...body.address };
  org.set(body);
  await org.save();
  audit(req, { action: 'organization.update', entityType: 'Organization', entityId: org._id, changes: diff(before, org.toJSON(), Object.keys(body)) });
  const { adminNotes, ...rest } = org.toJSON();
  void adminNotes;
  return rest;
});

r.put('/settings', { permission: 'org.update', body: SettingsDto, summary: 'Update billing & policy settings' }, async req => {
  const org = await Organization.findById(req.ctx.orgId);
  const before = org.toJSON().settings;
  const next = { ...before, ...req.valid.body };
  if (req.valid.body.lateFee) next.lateFee = { ...before.lateFee, ...req.valid.body.lateFee };
  org.settings = next;
  await org.save();
  audit(req, { action: 'organization.settings', entityType: 'Organization', entityId: org._id, changes: diff(before, next, Object.keys(req.valid.body)) });
  return org.toJSON().settings;
});

r.get('/usage', { permission: 'org.read', summary: 'Usage against plan limits' }, async req => {
  const [counts, state] = await Promise.all([usage(req.ctx.orgId), getState(req.ctx.orgId)]);
  return Object.keys(LIMIT_KEYS).map(key => ({
    key,
    label: LIMIT_KEYS[key],
    used: counts[key],
    limit: state.entitlements.limits[key] ?? -1,
  }));
});

r.get(
  '/audit-logs',
  {
    permission: 'org.audit.read',
    query: listQuery({ action: z.string().max(60).optional(), entityType: z.string().max(40).optional(), ...dateRange }),
    summary: 'Organization audit log',
  },
  async req => {
    const q = req.valid.query;
    const filter = { organizationId: req.ctx.orgId };
    if (q.action) filter.action = q.action;
    if (q.entityType) filter.entityType = q.entityType;
    if (q.from || q.to) {
      filter.createdAt = {};
      if (q.from) filter.createdAt.$gte = D.toDay(q.from);
      if (q.to) filter.createdAt.$lt = D.addDays(D.toDay(q.to), 1);
    }
    return paginate(AuditLog, filter, listOptions(q, { sortable: ['createdAt'], searchFields: ['summary', 'actorName', 'action'] }));
  },
);

module.exports = r.router;
