const { createRouter } = require('../../core/router');
const { z, text, id, idParams, listQuery, dayKey, dateRange } = require('../../core/validation');
const CheckIn = require('../models/CheckIn');
const CheckOut = require('../models/CheckOut');
const TenantAgreement = require('../models/TenantAgreement');
const Rent = require('../models/Rent');
const Tenant = require('../models/Tenant');
const { checkIn } = require('../services/checkin');
const { previewCheckout, executeCheckout } = require('../services/checkout');
const { RECURRING_CHARGE_TYPES } = require('../services/billing');
const { listOptions, paginate } = require('../../core/query');
const { loadOwned } = require('../../core/refs');
const { propertyScope } = require('../../core/context');
const { publicDoc } = require('../../core/schema');
const { audit, diff } = require('../../core/audit');
const D = require('../../core/dates');
const errors = require('../../core/errors');

const ChargeDto = z.object({
  type: z.enum(RECURRING_CHARGE_TYPES),
  label: text(60).optional(),
  amount: z.coerce.number().min(0).max(1000000),
});
const DiscountDto = z.object({
  type: z.enum(['FLAT', 'PERCENT']),
  value: z.coerce.number().min(0).max(1000000),
  label: text(60).optional(),
});

const withTenantNames = async (req, items) => {
  const tenants = await Tenant.find({ organizationId: req.ctx.orgId, _id: { $in: [...new Set(items.map(i => i.tenantId))] } })
    .select('fullName phone')
    .lean();
  const of = new Map(tenants.map(t => [t._id, t]));
  return items.map(i => ({ ...i, tenantName: (of.get(i.tenantId) || {}).fullName || '' }));
};

const dateFilter = (field, q) => {
  if (!q.from && !q.to) return {};
  const f = {};
  if (q.from) f.$gte = D.toDay(q.from);
  if (q.to) f.$lt = D.addDays(D.toDay(q.to), 1);
  return { [field]: f };
};

// ---- Check-ins ------------------------------------------------------------------

const checkins = createRouter({ prefix: '/pg/checkins', tag: 'Check-in / out' });

const CheckInDto = z.object({
  tenantId: id,
  bedId: id,
  checkInDate: dayKey.optional(),
  monthlyRent: z.coerce.number().min(0).max(1000000).optional(),
  depositAmount: z.coerce.number().min(0).max(10000000).optional(),
  billingDay: z.coerce.number().int().min(1).max(28).optional(),
  dueDays: z.coerce.number().int().min(0).max(60).optional(),
  charges: z.array(ChargeDto).max(10).optional(),
  discount: DiscountDto.optional(),
  messOptIn: z.boolean().optional(),
  agreement: z
    .object({
      endDate: dayKey.optional(),
      lockInMonths: z.coerce.number().int().min(0).max(60).optional(),
      noticePeriodDays: z.coerce.number().int().min(0).max(180).optional(),
      terms: text(20000).optional(),
    })
    .optional(),
  collect: z
    .object({
      amount: z.coerce.number().gt(0).max(10000000),
      method: z.enum(['CASH', 'UPI', 'BANK_TRANSFER', 'CARD']),
      reference: text(120).optional(),
    })
    .optional(),
  notes: text(1000).optional(),
});

checkins.post('/', { permission: 'checkin.create', body: CheckInDto, success: 201, summary: 'Check a tenant in (bed, rent, deposit, agreement)' }, req =>
  checkIn(req, req.valid.body),
);

checkins.get('/', { permission: 'tenant.read', query: listQuery({ propertyId: id.optional(), tenantId: id.optional(), ...dateRange }), summary: 'Check-in records' }, async req => {
  const q = req.valid.query;
  const filter = { organizationId: req.ctx.orgId, ...propertyScope(req, 'propertyId', q.propertyId), ...dateFilter('checkInDate', q) };
  if (q.tenantId) filter.tenantId = q.tenantId;
  const page = await paginate(CheckIn, filter, listOptions(q, { sortable: ['checkInDate', 'createdAt'], defaultSort: '-checkInDate' }));
  page.items = await withTenantNames(req, page.items);
  return page;
});

checkins.get('/:id', { permission: 'tenant.read', params: idParams, summary: 'Check-in record' }, async req =>
  publicDoc(await loadOwned(CheckIn, req.valid.params.id, req, { entity: 'Check-in', lean: true })),
);

// ---- Check-outs ------------------------------------------------------------------

const checkouts = createRouter({ prefix: '/pg/checkouts', tag: 'Check-in / out' });

const LineItem = z.object({ description: text(120).optional(), amount: z.coerce.number().min(0).max(10000000) });
const CheckOutDto = z.object({
  tenantId: id,
  checkoutDate: dayKey,
  electricity: z.coerce.number().min(0).max(10000000).optional(),
  damages: z.array(LineItem).max(20).optional(),
  otherCharges: z.array(LineItem).max(20).optional(),
  waiveNoticeShortfall: z.boolean().optional(),
  reason: text(300).optional(),
  notes: text(1000).optional(),
});

checkouts.post('/preview', { permission: 'checkout.create', body: CheckOutDto, write: false, summary: 'Preview the final settlement' }, req =>
  previewCheckout(req, req.valid.body.tenantId, req.valid.body),
);

checkouts.post('/', { permission: 'checkout.create', body: CheckOutDto, success: 201, summary: 'Check out & settle (releases the bed)' }, req =>
  executeCheckout(req, req.valid.body.tenantId, req.valid.body),
);

checkouts.get('/', { permission: 'tenant.read', query: listQuery({ propertyId: id.optional(), tenantId: id.optional(), ...dateRange }), summary: 'Check-out records' }, async req => {
  const q = req.valid.query;
  const filter = { organizationId: req.ctx.orgId, ...propertyScope(req, 'propertyId', q.propertyId), ...dateFilter('checkoutDate', q) };
  if (q.tenantId) filter.tenantId = q.tenantId;
  const page = await paginate(CheckOut, filter, listOptions(q, { sortable: ['checkoutDate', 'createdAt'], defaultSort: '-checkoutDate' }));
  page.items = await withTenantNames(req, page.items);
  return page;
});

checkouts.get('/:id', { permission: 'tenant.read', params: idParams, summary: 'Check-out settlement' }, async req =>
  publicDoc(await loadOwned(CheckOut, req.valid.params.id, req, { entity: 'Check-out', lean: true })),
);

// ---- Agreements ------------------------------------------------------------------

const agreements = createRouter({ prefix: '/pg/agreements', tag: 'Agreements' });

agreements.get('/', { permission: 'tenant.read', query: listQuery({ tenantId: id.optional(), status: z.enum(['DRAFT', 'ACTIVE', 'ENDED', 'TERMINATED']).optional() }), summary: 'Tenant agreements' }, async req => {
  const q = req.valid.query;
  const filter = { organizationId: req.ctx.orgId, ...propertyScope(req, 'propertyId') };
  if (q.tenantId) filter.tenantId = q.tenantId;
  if (q.status) filter.status = q.status;
  const page = await paginate(TenantAgreement, filter, listOptions(q, { sortable: ['startDate', 'createdAt'], defaultSort: '-startDate' }));
  page.items = await withTenantNames(req, page.items);
  return page;
});

agreements.get('/:id', { permission: 'tenant.read', params: idParams, summary: 'Agreement' }, async req =>
  publicDoc(await loadOwned(TenantAgreement, req.valid.params.id, req, { entity: 'Agreement', lean: true })),
);

agreements.put(
  '/:id',
  {
    permission: 'agreement.manage',
    params: idParams,
    body: z.object({
      endDate: dayKey.nullable().optional(),
      lockInMonths: z.coerce.number().int().min(0).max(60).optional(),
      noticePeriodDays: z.coerce.number().int().min(0).max(180).optional(),
      terms: text(20000).optional(),
    }),
    summary: 'Edit agreement terms (resets tenant acceptance)',
  },
  async req => {
    const a = await loadOwned(TenantAgreement, req.valid.params.id, req, { entity: 'Agreement' });
    if (a.status !== 'ACTIVE' && a.status !== 'DRAFT') throw errors.conflict('Only current agreements can be edited.', 'AGREEMENT_STATE');
    const before = a.toJSON();
    const b = req.valid.body;
    if (b.endDate !== undefined) a.endDate = b.endDate ? D.toDay(b.endDate) : null;
    if (b.lockInMonths !== undefined) a.lockInMonths = b.lockInMonths;
    if (b.noticePeriodDays !== undefined) {
      a.noticePeriodDays = b.noticePeriodDays;
      await Tenant.updateOne({ _id: a.tenantId, organizationId: req.ctx.orgId }, { $set: { noticePeriodDays: b.noticePeriodDays } });
    }
    if (b.terms !== undefined) a.terms = b.terms;
    // Changed terms need fresh consent.
    a.acceptedAt = null;
    a.acceptedByUserId = null;
    await a.save();
    audit(req, { action: 'agreement.update', entityType: 'TenantAgreement', entityId: a._id, changes: diff(before, a.toJSON(), Object.keys(b)) });
    return a.toJSON();
  },
);

// ---- Recurring rent ------------------------------------------------------------------

const rents = createRouter({ prefix: '/pg/rents', tag: 'Rent' });

rents.get('/', { permission: 'rent.read', query: listQuery({ tenantId: id.optional(), propertyId: id.optional(), status: z.enum(['ACTIVE', 'ENDED']).optional() }), summary: 'Recurring rent configurations' }, async req => {
  const q = req.valid.query;
  const filter = { organizationId: req.ctx.orgId, ...propertyScope(req, 'propertyId', q.propertyId) };
  if (q.tenantId) filter.tenantId = q.tenantId;
  if (q.status) filter.status = q.status;
  const page = await paginate(Rent, filter, listOptions(q, { sortable: ['createdAt', 'monthlyRent', 'nextBillingDate'] }));
  page.items = await withTenantNames(req, page.items);
  return page;
});

rents.get('/:id', { permission: 'rent.read', params: idParams, summary: 'Rent configuration' }, async req =>
  publicDoc(await loadOwned(Rent, req.valid.params.id, req, { entity: 'Rent', lean: true })),
);

rents.put(
  '/:id',
  {
    permission: 'rent.manage',
    params: idParams,
    body: z.object({
      monthlyRent: z.coerce.number().min(0).max(1000000).optional(),
      dueDays: z.coerce.number().int().min(0).max(60).optional(),
      charges: z.array(ChargeDto).max(10).optional(),
      discount: DiscountDto.nullable().optional(),
    }),
    summary: 'Change rent / recurring charges (applies from the next invoice)',
  },
  async req => {
    const rent = await loadOwned(Rent, req.valid.params.id, req, { entity: 'Rent' });
    if (rent.status !== 'ACTIVE') throw errors.conflict('This rent has ended.', 'RENT_ENDED');
    const before = rent.toJSON();
    const b = req.valid.body;
    if (b.monthlyRent !== undefined) rent.monthlyRent = b.monthlyRent;
    if (b.dueDays !== undefined) rent.dueDays = b.dueDays;
    if (b.charges !== undefined) rent.charges = b.charges;
    if (b.discount !== undefined) rent.discount = b.discount || { type: 'FLAT', value: 0, label: '' };
    await rent.save();
    if (b.monthlyRent !== undefined) {
      await Tenant.updateOne({ _id: rent.tenantId, organizationId: req.ctx.orgId }, { $set: { monthlyRent: b.monthlyRent } });
    }
    audit(req, { action: 'rent.update', entityType: 'Rent', entityId: rent._id, changes: diff(before, rent.toJSON(), Object.keys(b)) });
    return rent.toJSON();
  },
);

module.exports = {
  checkinsRouter: checkins.router,
  checkoutsRouter: checkouts.router,
  agreementsRouter: agreements.router,
  rentsRouter: rents.router,
};
