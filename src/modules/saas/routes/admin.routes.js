const { createRouter } = require('../../core/router');
const { z, text, requiredText, id, idParams, listQuery, dateRange, dayKey } = require('../../core/validation');
const Organization = require('../models/Organization');
const OrganizationUser = require('../models/OrganizationUser');
const Subscription = require('../models/Subscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const Coupon = require('../models/Coupon');
const FeatureFlag = require('../models/FeatureFlag');
const SupportTicket = require('../models/SupportTicket');
const AuditLog = require('../../core/AuditLog');
const AnalyticsEvent = require('../../analytics/AnalyticsEvent');
const User = require('../../../models/User');
const PgProperty = require('../../pg/models/PgProperty');
const Bed = require('../../pg/models/Bed');
const Tenant = require('../../pg/models/Tenant');
const Payment = require('../../pg/models/Payment');
const { usage } = require('../services/entitlements');
const { getSettings, updateSettings } = require('../services/settings');
const { invalidatePlans, LIMIT_KEYS, FEATURE_KEYS, isFreePlan } = require('../services/plans');
const { invalidateFlags, isEnabledFor } = require('../services/featureFlags');
const subs = require('../services/subscriptions');
const { memberUserIds } = require('../services/members');
const { listOptions, paginate, escapeRegex } = require('../../core/query');
const { unscoped } = require('../../core/scope');
const { publicDoc } = require('../../core/schema');
const { audit } = require('../../core/audit');
const { round2 } = require('../../core/money');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');

const r = createRouter({ prefix: '/pg/admin', tag: 'Super Admin' });
const SA = { auth: 'superadmin' };
const DAY = 24 * 3600 * 1000;

const PAID_SUCCESS = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

// ---- Dashboard -----------------------------------------------------------------------

const computeMrr = async subsList => {
  const payIds = subsList.map(s => s.lastPaymentId).filter(Boolean);
  const payments = payIds.length ? await unscoped(() => SubscriptionPayment.find({ _id: { $in: payIds } }).select('amount billingCycle').lean()) : [];
  const payOf = new Map(payments.map(p => [p._id, p]));
  const plans = await SubscriptionPlan.find({}).lean();
  const planOf = new Map(plans.map(p => [p.code, p]));
  let mrr = 0;
  for (const s of subsList) {
    const plan = planOf.get(s.planCode);
    if (!plan || isFreePlan(plan)) continue;
    const p = s.lastPaymentId && payOf.get(s.lastPaymentId);
    const cycle = (p && p.billingCycle) || s.billingCycle;
    const amount = p ? p.amount : cycle === 'YEARLY' ? plan.priceYearly : plan.priceMonthly;
    mrr += cycle === 'YEARLY' ? amount / 12 : amount;
  }
  return round2(mrr);
};

r.get('/dashboard', { ...SA, summary: 'Platform KPIs' }, async () => {
  const since30 = new Date(Date.now() - 30 * DAY);
  return unscoped(async () => {
    const [orgs, activeOrgs, suspendedOrgs, newOrgs, allSubs, properties, beds, occupiedBeds, tenants, planRows] = await Promise.all([
      Organization.countDocuments({}),
      Organization.countDocuments({ status: 'ACTIVE' }),
      Organization.countDocuments({ status: 'SUSPENDED' }),
      Organization.countDocuments({ createdAt: { $gte: since30 } }),
      Subscription.find({}).select('planCode status billingCycle lastPaymentId history trialEndsAt').lean(),
      PgProperty.countDocuments({}),
      Bed.countDocuments({}),
      Bed.countDocuments({ status: 'OCCUPIED' }),
      Tenant.countDocuments({ status: { $in: ['ACTIVE', 'NOTICE'] } }),
      Subscription.aggregate([{ $group: { _id: { plan: '$planCode', status: '$status' }, n: { $sum: 1 } } }]),
    ]);
    const byStatus = s => allSubs.filter(x => x.status === s).length;
    const plans = await SubscriptionPlan.find({}).lean();
    const planOf = new Map(plans.map(p => [p.code, p]));
    const paying = allSubs.filter(s => s.status === 'ACTIVE' && !isFreePlan(planOf.get(s.planCode)));
    const mrr = await computeMrr(paying);

    // Paying subscriptions lost in the last 30 days.
    const churned = allSubs.filter(s =>
      (s.history || []).some(h => ['cancelled', 'expired'].includes(h.event) && new Date(h.at) >= since30 && !isFreePlan(planOf.get(h.fromPlan))),
    ).length;
    const [rentVolume, rentVolume30, onlineRent30, subVolume, subVolume30] = await Promise.all([
      Payment.aggregate([{ $match: { status: { $in: PAID_SUCCESS }, method: { $ne: 'DEPOSIT_ADJUSTMENT' } } }, { $group: { _id: null, v: { $sum: '$amount' }, n: { $sum: 1 } } }]),
      Payment.aggregate([{ $match: { status: { $in: PAID_SUCCESS }, method: { $ne: 'DEPOSIT_ADJUSTMENT' }, paidAt: { $gte: since30 } } }, { $group: { _id: null, v: { $sum: '$amount' }, n: { $sum: 1 } } }]),
      Payment.aggregate([{ $match: { status: { $in: PAID_SUCCESS }, method: 'ONLINE', paidAt: { $gte: since30 } } }, { $group: { _id: null, v: { $sum: '$amount' }, n: { $sum: 1 } } }]),
      SubscriptionPayment.aggregate([{ $match: { status: 'SUCCEEDED' } }, { $group: { _id: null, v: { $sum: '$amount' }, n: { $sum: 1 } } }]),
      SubscriptionPayment.aggregate([{ $match: { status: 'SUCCEEDED', paidAt: { $gte: since30 } } }, { $group: { _id: null, v: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    ]);
    const v = rows => (rows[0] ? round2(rows[0].v) : 0);
    const signups = await Organization.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 180 * DAY) } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    return {
      totalOrganizations: orgs,
      activeOrganizations: activeOrgs,
      suspendedOrganizations: suspendedOrgs,
      newOrganizations30d: newOrgs,
      activeSubscriptions: byStatus('ACTIVE'),
      payingSubscriptions: paying.length,
      trialOrganizations: byStatus('TRIAL'),
      pastDue: byStatus('PAST_DUE'),
      expired: byStatus('EXPIRED'),
      cancelled: byStatus('CANCELLED'),
      suspendedSubscriptions: byStatus('SUSPENDED'),
      mrr,
      arr: round2(mrr * 12),
      churned30d: churned,
      churnRate30d: paying.length + churned ? round2((churned / (paying.length + churned)) * 100) : 0,
      totalProperties: properties,
      totalBeds: beds,
      occupiedBeds,
      occupancyPct: beds ? round2((occupiedBeds / beds) * 100) : 0,
      totalTenants: tenants,
      paymentVolume: {
        rentAllTime: v(rentVolume),
        rent30d: v(rentVolume30),
        onlineRent30d: v(onlineRent30),
        subscriptionsAllTime: v(subVolume),
        subscriptions30d: v(subVolume30),
      },
      planBreakdown: planRows.map(p => ({ plan: p._id.plan, status: p._id.status, count: p.n })),
      signups: signups.map(s => ({ month: s._id, count: s.n })),
    };
  });
});

// ---- Organizations -------------------------------------------------------------------

const orgSummary = async orgs => {
  const ids = orgs.map(o => o.id);
  return unscoped(async () => {
    const [subsList, props, beds, tenants, owners] = await Promise.all([
      Subscription.find({ organizationId: { $in: ids } }).select('organizationId planCode status trialEndsAt currentPeriodEnd').lean(),
      PgProperty.aggregate([{ $match: { organizationId: { $in: ids }, deletedAt: null } }, { $group: { _id: '$organizationId', n: { $sum: 1 } } }]),
      Bed.aggregate([{ $match: { organizationId: { $in: ids }, deletedAt: null } }, { $group: { _id: '$organizationId', n: { $sum: 1 }, occ: { $sum: { $cond: [{ $eq: ['$status', 'OCCUPIED'] }, 1, 0] } } } }]),
      Tenant.aggregate([{ $match: { organizationId: { $in: ids }, deletedAt: null, status: { $in: ['ACTIVE', 'NOTICE'] } } }, { $group: { _id: '$organizationId', n: { $sum: 1 } } }]),
      OrganizationUser.find({ organizationId: { $in: ids }, role: 'OWNER', status: 'ACTIVE' }).select('organizationId displayName phone email').lean(),
    ]);
    const m = rows => new Map(rows.map(x => [x._id, x]));
    const subOf = new Map(subsList.map(s => [s.organizationId, s]));
    const [po, bo, to] = [m(props), m(beds), m(tenants)];
    return orgs.map(o => {
      const s = subOf.get(o.id) || {};
      const b = bo.get(o.id) || {};
      return {
        ...o,
        subscription: { planCode: s.planCode || null, status: s.status || null, trialEndsAt: s.trialEndsAt || null, currentPeriodEnd: s.currentPeriodEnd || null },
        properties: (po.get(o.id) || {}).n || 0,
        beds: b.n || 0,
        occupiedBeds: b.occ || 0,
        tenants: (to.get(o.id) || {}).n || 0,
        owners: owners.filter(x => x.organizationId === o.id).map(x => ({ name: x.displayName, phone: x.phone, email: x.email })),
      };
    });
  });
};

r.get(
  '/organizations',
  {
    ...SA,
    query: listQuery({ status: z.enum(['ACTIVE', 'SUSPENDED']).optional(), planCode: z.string().max(32).optional(), subscriptionStatus: z.string().max(20).optional() }),
    summary: 'All organizations',
  },
  async req => {
    const q = req.valid.query;
    const filter = {};
    if (q.status) filter.status = q.status;
    if (q.planCode || q.subscriptionStatus) {
      const subFilter = {};
      if (q.planCode) subFilter.planCode = q.planCode.toUpperCase();
      if (q.subscriptionStatus) subFilter.status = q.subscriptionStatus.toUpperCase();
      const orgIds = await unscoped(() => Subscription.distinct('organizationId', subFilter));
      filter._id = { $in: orgIds };
    }
    const page = await paginate(Organization, filter, listOptions(q, { sortable: ['createdAt', 'name'], searchFields: ['name', 'slug', 'phone', 'email', 'address.city'] }));
    page.items = await orgSummary(page.items);
    return page;
  },
);

r.get('/organizations/:id', { ...SA, params: idParams, summary: 'Organization 360°' }, async req => {
  const orgId = req.valid.params.id;
  const org = await Organization.findById(orgId).lean();
  if (!org) throw errors.notFound('Organization');
  return unscoped(async () => {
    const [[summary], sub, members, properties, payments, counts, tickets, flags] = await Promise.all([
      orgSummary([publicDoc(org)]),
      Subscription.findOne({ organizationId: orgId }).lean(),
      OrganizationUser.find({ organizationId: orgId, role: { $ne: 'TENANT' } }).select('displayName phone email role status joinedAt').lean(),
      PgProperty.find({ organizationId: orgId }).select('name address.city status createdAt').lean(),
      SubscriptionPayment.find({ organizationId: orgId }).sort({ createdAt: -1 }).limit(20).lean(),
      usage(orgId),
      SupportTicket.find({ organizationId: orgId }).sort({ lastActivityAt: -1 }).limit(10).select('-messages').lean(),
      FeatureFlag.find({}).lean(),
    ]);
    return {
      ...summary,
      subscriptionDetail: sub ? publicDoc(sub) : null,
      usage: Object.keys(LIMIT_KEYS).map(k => ({ key: k, label: LIMIT_KEYS[k], used: counts[k] })),
      members: members.map(publicDoc),
      propertiesList: properties.map(publicDoc),
      billing: payments.map(publicDoc),
      tickets: tickets.map(publicDoc),
      featureFlags: flags.map(f => ({ key: f.key, enabled: isEnabledFor(f, orgId) })),
    };
  });
});

r.put(
  '/organizations/:id',
  {
    ...SA,
    params: idParams,
    body: z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']).optional(), suspendedReason: text(300).optional(), adminNotes: text(5000).optional() }),
    summary: 'Suspend / reactivate / annotate an organization',
  },
  async req => {
    const org = await Organization.findById(req.valid.params.id);
    if (!org) throw errors.notFound('Organization');
    const before = { status: org.status };
    org.set(req.valid.body);
    if (req.valid.body.status === 'ACTIVE') org.suspendedReason = '';
    await org.save();
    audit(req, { organizationId: org._id, action: 'admin.organization.update', entityType: 'Organization', entityId: org._id, changes: { status: { from: before.status, to: org.status } }, summary: req.valid.body.suspendedReason || '' });
    if (req.valid.body.status && req.valid.body.status !== before.status) {
      const owners = await unscoped(() => memberUserIds(org._id, ['OWNER']));
      notify({
        userIds: owners,
        organizationId: org._id,
        type: 'subscription',
        title: org.status === 'SUSPENDED' ? 'Organization suspended' : 'Organization reactivated',
        body: org.status === 'SUSPENDED' ? `Your organization was suspended. ${org.suspendedReason || 'Contact support.'}` : 'Your organization is active again.',
        data: { route: 'subscription' },
        channels: ['inapp', 'push', 'email'],
      });
    }
    return publicDoc(org.toJSON());
  },
);

r.get('/owners', { ...SA, query: listQuery(), summary: 'Organization owners' }, async req =>
  unscoped(async () => {
    const q = req.valid.query;
    const page = await paginate(OrganizationUser, { role: 'OWNER' }, listOptions(q, { sortable: ['createdAt', 'displayName'], searchFields: ['displayName', 'phone', 'email'] }));
    const orgs = await Organization.find({ _id: { $in: page.items.map(i => i.organizationId) } }).select('name status').lean();
    const orgOf = new Map(orgs.map(o => [o._id, o]));
    page.items = page.items.map(i => ({ ...i, organizationName: (orgOf.get(i.organizationId) || {}).name || '', organizationStatus: (orgOf.get(i.organizationId) || {}).status || '' }));
    return page;
  }),
);

r.get('/properties', { ...SA, query: listQuery({ organizationId: id.optional() }), summary: 'Properties across organizations' }, async req =>
  unscoped(async () => {
    const q = req.valid.query;
    const filter = q.organizationId ? { organizationId: q.organizationId } : {};
    const page = await paginate(PgProperty, filter, listOptions(q, { sortable: ['createdAt', 'name'], searchFields: ['name', 'address.city'] }), { select: 'name address propertyType genderType status organizationId createdAt' });
    const ids = page.items.map(p => p.id);
    const [orgs, beds] = await Promise.all([
      Organization.find({ _id: { $in: [...new Set(page.items.map(p => p.organizationId))] } }).select('name').lean(),
      Bed.aggregate([{ $match: { propertyId: { $in: ids }, deletedAt: null } }, { $group: { _id: '$propertyId', n: { $sum: 1 }, occ: { $sum: { $cond: [{ $eq: ['$status', 'OCCUPIED'] }, 1, 0] } } } }]),
    ]);
    const orgOf = new Map(orgs.map(o => [o._id, o.name]));
    const bedOf = new Map(beds.map(b => [b._id, b]));
    page.items = page.items.map(p => ({ ...p, organizationName: orgOf.get(p.organizationId) || '', beds: (bedOf.get(p.id) || {}).n || 0, occupiedBeds: (bedOf.get(p.id) || {}).occ || 0 }));
    return page;
  }),
);

// ---- Subscriptions ---------------------------------------------------------------------

r.get('/subscriptions', { ...SA, query: listQuery({ status: z.string().max(20).optional(), planCode: z.string().max(32).optional(), trialEndingInDays: z.coerce.number().int().min(0).max(90).optional() }), summary: 'All subscriptions' }, async req =>
  unscoped(async () => {
    const q = req.valid.query;
    const filter = {};
    if (q.status) filter.status = q.status.toUpperCase();
    if (q.planCode) filter.planCode = q.planCode.toUpperCase();
    if (q.trialEndingInDays !== undefined) {
      filter.status = 'TRIAL';
      filter.trialEndsAt = { $lte: new Date(Date.now() + q.trialEndingInDays * DAY) };
    }
    const page = await paginate(Subscription, filter, listOptions(q, { sortable: ['createdAt', 'trialEndsAt', 'currentPeriodEnd'] }), { select: '-history' });
    const orgs = await Organization.find({ _id: { $in: page.items.map(s => s.organizationId) } }).select('name status').lean();
    const orgOf = new Map(orgs.map(o => [o._id, o]));
    page.items = page.items.map(s => ({ ...s, organizationName: (orgOf.get(s.organizationId) || {}).name || '' }));
    return page;
  }),
);

r.get('/trials', { ...SA, query: listQuery(), summary: 'Organizations in trial (ending soonest first)' }, async req =>
  unscoped(async () => {
    const page = await paginate(Subscription, { status: 'TRIAL' }, listOptions({ ...req.valid.query, sort: 'trialEndsAt' }, { sortable: ['trialEndsAt'] }), { select: '-history' });
    const orgs = await Organization.find({ _id: { $in: page.items.map(s => s.organizationId) } }).select('name phone email').lean();
    const orgOf = new Map(orgs.map(o => [o._id, o]));
    page.items = page.items.map(s => ({ ...s, organizationName: (orgOf.get(s.organizationId) || {}).name || '', daysLeft: s.trialEndsAt ? Math.max(0, Math.ceil((new Date(s.trialEndsAt) - Date.now()) / DAY)) : null }));
    return page;
  }),
);

const orgParam = z.object({ orgId: id });
const loadOrg = async orgId => {
  if (!(await Organization.exists({ _id: orgId }))) throw errors.notFound('Organization');
};

r.post(
  '/subscriptions/:orgId/change-plan',
  { ...SA, params: orgParam, body: z.object({ planCode: z.string().trim().toUpperCase().max(32), billingCycle: z.enum(['MONTHLY', 'YEARLY']).default('MONTHLY'), periodEnd: dayKey.optional(), note: text(300).optional() }), summary: 'Set plan manually (offline billing / comp)' },
  async req => {
    const { orgId } = req.valid.params;
    await loadOrg(orgId);
    const b = req.valid.body;
    const result = await unscoped(() =>
      subs.activatePlan(orgId, { planCode: b.planCode, billingCycle: b.billingCycle, periodEnd: b.periodEnd ? new Date(`${b.periodEnd}T00:00:00Z`) : null, userId: req.user._id, note: b.note || 'Changed by platform admin' }),
    );
    audit(req, { organizationId: orgId, action: 'admin.subscription.change_plan', entityType: 'Subscription', entityId: orgId, summary: `${b.planCode} ${b.note || ''}` });
    subs.afterActivation(orgId, result, req.user._id);
    return result.subscription;
  },
);

r.post('/subscriptions/:orgId/extend-trial', { ...SA, params: orgParam, body: z.object({ days: z.coerce.number().int().min(1).max(180) }), summary: 'Extend / restart a trial' }, async req => {
  const { orgId } = req.valid.params;
  await loadOrg(orgId);
  const sub = await unscoped(() => subs.extendTrial(orgId, req.valid.body.days, req.user._id));
  audit(req, { organizationId: orgId, action: 'admin.subscription.extend_trial', entityType: 'Subscription', entityId: orgId, summary: `+${req.valid.body.days} days` });
  return sub;
});

r.post('/subscriptions/:orgId/suspend', { ...SA, params: orgParam, body: z.object({ reason: requiredText(300) }), summary: 'Suspend a subscription' }, async req => {
  const { orgId } = req.valid.params;
  await loadOrg(orgId);
  const sub = await unscoped(() => subs.suspend(orgId, req.valid.body.reason, req.user._id));
  audit(req, { organizationId: orgId, action: 'admin.subscription.suspend', entityType: 'Subscription', entityId: orgId, summary: req.valid.body.reason });
  return sub;
});

r.post('/subscriptions/:orgId/reactivate', { ...SA, params: orgParam, summary: 'Lift a subscription suspension' }, async req => {
  const { orgId } = req.valid.params;
  await loadOrg(orgId);
  const sub = await unscoped(() => subs.reactivate(orgId, req.user._id));
  audit(req, { organizationId: orgId, action: 'admin.subscription.reactivate', entityType: 'Subscription', entityId: orgId });
  return sub;
});

const LimitsDto = z.record(z.coerce.number().int().min(-1).max(1000000));
const FeaturesDto = z.record(z.boolean());

r.put('/subscriptions/:orgId/overrides', { ...SA, params: orgParam, body: z.object({ limits: LimitsDto.optional(), features: FeaturesDto.optional() }), summary: 'Per-organization entitlement overrides' }, async req => {
  const { orgId } = req.valid.params;
  await loadOrg(orgId);
  const unknownLimit = Object.keys(req.valid.body.limits || {}).find(k => !LIMIT_KEYS[k]);
  const unknownFeature = Object.keys(req.valid.body.features || {}).find(k => !FEATURE_KEYS[k]);
  if (unknownLimit || unknownFeature) throw errors.badRequest(`Unknown entitlement: ${unknownLimit || unknownFeature}`, 'VALIDATION_ERROR');
  const sub = await unscoped(() => subs.setOverrides(orgId, req.valid.body, req.user._id));
  audit(req, { organizationId: orgId, action: 'admin.subscription.overrides', entityType: 'Subscription', entityId: orgId, changes: req.valid.body });
  return sub;
});

// ---- Plans -------------------------------------------------------------------------------

const PlanDto = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,32}$/),
  name: requiredText(60),
  tagline: text(140).optional(),
  description: text(1000).optional(),
  priceMonthly: z.coerce.number().min(0).max(10000000),
  priceYearly: z.coerce.number().min(0).max(100000000),
  trialDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  limits: LimitsDto.default({}),
  features: FeaturesDto.default({}),
  isPublic: z.boolean().default(true),
  isActive: z.boolean().default(true),
  highlight: z.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(100).default(0),
});

const assertEntitlementKeys = body => {
  const bad = [...Object.keys(body.limits || {}).filter(k => !LIMIT_KEYS[k]), ...Object.keys(body.features || {}).filter(k => !FEATURE_KEYS[k])];
  if (bad.length) throw errors.badRequest(`Unknown entitlement(s): ${bad.join(', ')}`, 'VALIDATION_ERROR');
};

r.get('/plans', { ...SA, summary: 'All plans (incl. private / inactive)' }, async () => ({
  plans: (await SubscriptionPlan.find({}).sort({ sortOrder: 1 }).lean()).map(publicDoc),
  catalog: { limits: LIMIT_KEYS, features: FEATURE_KEYS },
}));

r.post('/plans', { ...SA, body: PlanDto, success: 201, summary: 'Create a plan' }, async req => {
  assertEntitlementKeys(req.valid.body);
  const plan = await SubscriptionPlan.create(req.valid.body);
  invalidatePlans();
  audit(req, { organizationId: null, action: 'admin.plan.create', entityType: 'SubscriptionPlan', entityId: plan._id, summary: plan.code });
  return plan.toJSON();
});

r.put('/plans/:id', { ...SA, params: idParams, body: PlanDto.omit({ code: true }).partial(), summary: 'Edit plan pricing / entitlements' }, async req => {
  assertEntitlementKeys(req.valid.body);
  const plan = await SubscriptionPlan.findById(req.valid.params.id);
  if (!plan) throw errors.notFound('Plan');
  plan.set(req.valid.body);
  await plan.save();
  invalidatePlans();
  audit(req, { organizationId: null, action: 'admin.plan.update', entityType: 'SubscriptionPlan', entityId: plan._id, changes: req.valid.body });
  return plan.toJSON();
});

r.delete('/plans/:id', { ...SA, params: idParams, summary: 'Delete an unused plan' }, async req => {
  const plan = await SubscriptionPlan.findById(req.valid.params.id);
  if (!plan) throw errors.notFound('Plan');
  const inUse = await unscoped(() => Subscription.countDocuments({ planCode: plan.code }));
  if (inUse) throw errors.conflict(`${inUse} organization(s) use this plan. Deactivate it instead.`, 'PLAN_IN_USE');
  await plan.softDelete(req.user._id);
  invalidatePlans();
  audit(req, { organizationId: null, action: 'admin.plan.delete', entityType: 'SubscriptionPlan', entityId: plan._id, summary: plan.code });
  return { id: plan._id, deleted: true };
});

// ---- Coupons -------------------------------------------------------------------------------

const CouponDto = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,32}$/),
  description: text(300).optional(),
  type: z.enum(['PERCENT', 'FLAT']),
  value: z.coerce.number().gt(0).max(10000000),
  maxRedemptions: z.coerce.number().int().min(0).max(1000000).default(0),
  validFrom: dayKey.nullable().optional(),
  validUntil: dayKey.nullable().optional(),
  planCodes: z.array(z.string().trim().toUpperCase().max(32)).max(20).default([]),
  billingCycles: z.array(z.enum(['MONTHLY', 'YEARLY'])).max(2).default([]),
  active: z.boolean().default(true),
});

const couponDates = b => ({
  ...b,
  ...(b.validFrom !== undefined ? { validFrom: b.validFrom ? new Date(`${b.validFrom}T00:00:00Z`) : null } : {}),
  ...(b.validUntil !== undefined ? { validUntil: b.validUntil ? new Date(`${b.validUntil}T23:59:59Z`) : null } : {}),
});

r.get('/coupons', { ...SA, query: listQuery({ active: z.enum(['true', 'false']).optional() }), summary: 'Coupons' }, async req => {
  const q = req.valid.query;
  return paginate(Coupon, q.active ? { active: q.active === 'true' } : {}, listOptions(q, { sortable: ['createdAt', 'code'], searchFields: ['code', 'description'] }));
});

r.post('/coupons', { ...SA, body: CouponDto, success: 201, summary: 'Create a coupon' }, async req => {
  if (req.valid.body.type === 'PERCENT' && req.valid.body.value > 100) throw errors.badRequest('Percent coupons cannot exceed 100%.', 'VALIDATION_ERROR');
  const coupon = await Coupon.create(couponDates(req.valid.body));
  audit(req, { organizationId: null, action: 'admin.coupon.create', entityType: 'Coupon', entityId: coupon._id, summary: coupon.code });
  return coupon.toJSON();
});

r.put('/coupons/:id', { ...SA, params: idParams, body: CouponDto.omit({ code: true }).partial(), summary: 'Edit a coupon' }, async req => {
  const coupon = await Coupon.findById(req.valid.params.id);
  if (!coupon) throw errors.notFound('Coupon');
  coupon.set(couponDates(req.valid.body));
  if (coupon.type === 'PERCENT' && coupon.value > 100) throw errors.badRequest('Percent coupons cannot exceed 100%.', 'VALIDATION_ERROR');
  await coupon.save();
  audit(req, { organizationId: null, action: 'admin.coupon.update', entityType: 'Coupon', entityId: coupon._id, changes: req.valid.body });
  return coupon.toJSON();
});

r.delete('/coupons/:id', { ...SA, params: idParams, summary: 'Delete a coupon' }, async req => {
  const coupon = await Coupon.findById(req.valid.params.id);
  if (!coupon) throw errors.notFound('Coupon');
  await coupon.softDelete(req.user._id);
  audit(req, { organizationId: null, action: 'admin.coupon.delete', entityType: 'Coupon', entityId: coupon._id, summary: coupon.code });
  return { id: coupon._id, deleted: true };
});

// ---- Payments & usage ----------------------------------------------------------------------

r.get('/payments/subscriptions', { ...SA, query: listQuery({ status: z.string().max(20).optional(), organizationId: id.optional(), ...dateRange }), summary: 'Platform billing payments' }, async req =>
  unscoped(async () => {
    const q = req.valid.query;
    const filter = {};
    if (q.status) filter.status = q.status.toUpperCase();
    if (q.organizationId) filter.organizationId = q.organizationId;
    if (q.from || q.to) {
      filter.createdAt = {};
      if (q.from) filter.createdAt.$gte = new Date(`${q.from}T00:00:00Z`);
      if (q.to) filter.createdAt.$lte = new Date(`${q.to}T23:59:59Z`);
    }
    const page = await paginate(SubscriptionPayment, filter, listOptions(q, { sortable: ['createdAt', 'amount'] }), { select: '-gateway.checkoutUrl' });
    const orgs = await Organization.find({ _id: { $in: page.items.map(p => p.organizationId) } }).select('name').lean();
    const orgOf = new Map(orgs.map(o => [o._id, o.name]));
    page.items = page.items.map(p => ({ ...p, organizationName: orgOf.get(p.organizationId) || '' }));
    return page;
  }),
);

r.get('/payments/rent', { ...SA, query: z.object({ ...dateRange }), summary: 'Rent payment volume by organization' }, async req =>
  unscoped(async () => {
    const q = req.valid.query;
    const match = { status: { $in: PAID_SUCCESS }, method: { $ne: 'DEPOSIT_ADJUSTMENT' } };
    if (q.from || q.to) {
      match.paidAt = {};
      if (q.from) match.paidAt.$gte = new Date(`${q.from}T00:00:00Z`);
      if (q.to) match.paidAt.$lte = new Date(`${q.to}T23:59:59Z`);
    }
    const rows = await Payment.aggregate([
      { $match: match },
      { $group: { _id: { org: '$organizationId', method: '$method' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    const orgIds = [...new Set(rows.map(r0 => r0._id.org))];
    const orgs = await Organization.find({ _id: { $in: orgIds } }).select('name').lean();
    const orgOf = new Map(orgs.map(o => [o._id, o.name]));
    const byOrg = new Map();
    for (const row of rows) {
      const cur = byOrg.get(row._id.org) || { organizationId: row._id.org, organizationName: orgOf.get(row._id.org) || '', total: 0, count: 0, byMethod: {} };
      cur.total = round2(cur.total + row.amount);
      cur.count += row.count;
      cur.byMethod[row._id.method] = round2(row.amount);
      byOrg.set(row._id.org, cur);
    }
    const items = [...byOrg.values()].sort((a, b) => b.total - a.total);
    return { items, total: round2(items.reduce((t, x) => t + x.total, 0)) };
  }),
);

r.get('/usage', { ...SA, query: listQuery(), summary: 'Usage vs limits across organizations' }, async req => {
  const q = req.valid.query;
  const page = await paginate(Organization, {}, listOptions(q, { sortable: ['createdAt', 'name'], searchFields: ['name'] }), { select: 'name status' });
  page.items = await Promise.all(
    page.items.map(async o => {
      const [counts, sub] = await Promise.all([unscoped(() => usage(o.id)), unscoped(() => Subscription.findOne({ organizationId: o.id }).lean())]);
      const plan = sub ? await SubscriptionPlan.findOne({ code: sub.planCode }).lean() : null;
      const limits = { ...((plan && plan.limits) || {}), ...((sub && sub.entitlementOverrides && sub.entitlementOverrides.limits) || {}) };
      return {
        ...o,
        planCode: sub ? sub.planCode : null,
        status: sub ? sub.status : null,
        usage: Object.keys(LIMIT_KEYS).map(k => ({ key: k, used: counts[k], limit: limits[k] ?? -1, pct: limits[k] > 0 ? round2((counts[k] / limits[k]) * 100) : null })),
      };
    }),
  );
  return page;
});

// ---- Feature flags -----------------------------------------------------------------------------

const FlagDto = z.object({
  key: z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{1,63}$/),
  description: text(300).optional(),
  enabled: z.boolean().default(false),
  enabledOrgIds: z.array(id).max(1000).default([]),
  disabledOrgIds: z.array(id).max(1000).default([]),
});

r.get('/feature-flags', { ...SA, summary: 'Feature flags' }, async () => (await FeatureFlag.find({}).sort({ key: 1 }).lean()).map(publicDoc));

r.post('/feature-flags', { ...SA, body: FlagDto, success: 201, summary: 'Create a feature flag' }, async req => {
  const flag = await FeatureFlag.create(req.valid.body);
  invalidateFlags();
  audit(req, { organizationId: null, action: 'admin.flag.create', entityType: 'FeatureFlag', entityId: flag._id, summary: flag.key });
  return flag.toJSON();
});

r.put('/feature-flags/:id', { ...SA, params: idParams, body: FlagDto.omit({ key: true }).partial(), summary: 'Toggle / target a feature flag' }, async req => {
  const flag = await FeatureFlag.findById(req.valid.params.id);
  if (!flag) throw errors.notFound('Feature flag');
  flag.set(req.valid.body);
  await flag.save();
  invalidateFlags();
  audit(req, { organizationId: null, action: 'admin.flag.update', entityType: 'FeatureFlag', entityId: flag._id, changes: req.valid.body });
  return flag.toJSON();
});

r.delete('/feature-flags/:id', { ...SA, params: idParams, summary: 'Delete a feature flag' }, async req => {
  const res = await FeatureFlag.deleteOne({ _id: req.valid.params.id });
  if (!res.deletedCount) throw errors.notFound('Feature flag');
  invalidateFlags();
  audit(req, { organizationId: null, action: 'admin.flag.delete', entityType: 'FeatureFlag', entityId: req.valid.params.id });
  return { id: req.valid.params.id, deleted: true };
});

// ---- Support ---------------------------------------------------------------------------------------

r.get('/support/tickets', { ...SA, query: listQuery({ status: z.string().max(30).optional(), priority: z.string().max(10).optional() }), summary: 'All support tickets' }, async req =>
  unscoped(async () => {
    const q = req.valid.query;
    const filter = {};
    if (q.status) filter.status = q.status.toUpperCase();
    if (q.priority) filter.priority = q.priority.toUpperCase();
    const page = await paginate(SupportTicket, filter, listOptions(q, { sortable: ['lastActivityAt', 'createdAt'], defaultSort: '-lastActivityAt', searchFields: ['subject', 'ticketNumber'] }), { select: '-messages' });
    const orgs = await Organization.find({ _id: { $in: page.items.map(t => t.organizationId) } }).select('name').lean();
    const orgOf = new Map(orgs.map(o => [o._id, o.name]));
    page.items = page.items.map(t => ({ ...t, organizationName: orgOf.get(t.organizationId) || '' }));
    return page;
  }),
);

const loadTicket = async ticketId => {
  const t = await unscoped(() => SupportTicket.findOne({ _id: ticketId }));
  if (!t) throw errors.notFound('Ticket');
  return t;
};

r.get('/support/tickets/:id', { ...SA, params: idParams, summary: 'Ticket conversation' }, async req => {
  const t = await loadTicket(req.valid.params.id);
  const org = await Organization.findById(t.organizationId).select('name').lean();
  return { ...t.toJSON(), organizationName: org ? org.name : '' };
});

r.post('/support/tickets/:id/messages', { ...SA, params: idParams, body: z.object({ body: requiredText(5000), status: z.enum(['IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED']).optional() }), summary: 'Reply as platform support' }, async req => {
  const t = await loadTicket(req.valid.params.id);
  t.messages.push({ authorUserId: req.user._id, authorName: 'Aabroo Support', fromPlatform: true, body: req.valid.body.body });
  t.status = req.valid.body.status || 'WAITING_ON_CUSTOMER';
  t.lastActivityAt = new Date();
  await t.save();
  audit(req, { organizationId: t.organizationId, action: 'admin.support.reply', entityType: 'SupportTicket', entityId: t._id });
  notify({ userIds: [t.createdByUserId], organizationId: t.organizationId, type: 'system', title: `Support replied: ${t.subject}`, body: req.valid.body.body.slice(0, 160), data: { route: 'support', id: t._id } });
  return t.toJSON();
});

r.put('/support/tickets/:id', { ...SA, params: idParams, body: z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED']).optional(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional() }), summary: 'Update ticket status / priority' }, async req => {
  const t = await loadTicket(req.valid.params.id);
  t.set(req.valid.body);
  t.lastActivityAt = new Date();
  await t.save();
  return t.toJSON();
});

// ---- Audit, settings, analytics -----------------------------------------------------------------------

r.get(
  '/audit-logs',
  { ...SA, query: listQuery({ organizationId: z.string().max(40).optional(), action: z.string().max(80).optional(), entityType: z.string().max(40).optional(), ...dateRange }), summary: 'Platform-wide audit log' },
  async req => {
    const q = req.valid.query;
    const filter = {};
    if (q.organizationId) filter.organizationId = q.organizationId === 'platform' ? null : q.organizationId;
    if (q.action) filter.action = new RegExp(`^${escapeRegex(q.action)}`);
    if (q.entityType) filter.entityType = q.entityType;
    if (q.from || q.to) {
      filter.createdAt = {};
      if (q.from) filter.createdAt.$gte = new Date(`${q.from}T00:00:00Z`);
      if (q.to) filter.createdAt.$lte = new Date(`${q.to}T23:59:59Z`);
    }
    return paginate(AuditLog, filter, listOptions(q, { sortable: ['createdAt'], searchFields: ['summary', 'actorName', 'action'] }));
  },
);

r.get('/settings', { ...SA, summary: 'Platform settings' }, async () => getSettings());

r.put(
  '/settings',
  {
    ...SA,
    body: z
      .object({
        trialDays: z.number().int().min(0).max(365),
        trialPlanCode: z.string().regex(/^[A-Z0-9_]{2,32}$/),
        freePlanCode: z.string().regex(/^[A-Z0-9_]{2,32}$/),
        graceDays: z.number().int().min(0).max(90),
        trialExpiryAction: z.enum(['EXPIRE', 'DOWNGRADE_TO_FREE']),
        maxOrganizationsPerOwner: z.number().int().min(1).max(100),
        supportEmail: z.string().email().max(160),
      })
      .partial(),
    summary: 'Update platform settings',
  },
  async req => {
    for (const key of ['trialPlanCode', 'freePlanCode']) {
      if (req.valid.body[key] && !(await SubscriptionPlan.exists({ code: req.valid.body[key] }))) {
        throw errors.badRequest(`Plan ${req.valid.body[key]} does not exist.`, 'VALIDATION_ERROR');
      }
    }
    const settings = await updateSettings(req.valid.body, req.user._id);
    audit(req, { organizationId: null, action: 'admin.settings.update', entityType: 'PlatformSetting', entityId: 'platform', changes: req.valid.body });
    return settings;
  },
);

r.get('/analytics', { ...SA, query: z.object({ days: z.coerce.number().int().min(1).max(180).default(30) }), summary: 'Product usage events' }, async req => {
  const since = new Date(Date.now() - req.valid.query.days * DAY);
  const [byName, daily, actives] = await Promise.all([
    AnalyticsEvent.aggregate([{ $match: { occurredAt: { $gte: since } } }, { $group: { _id: { name: '$name', module: '$module' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    AnalyticsEvent.aggregate([
      { $match: { occurredAt: { $gte: since } } },
      { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt' } }, module: '$module' }, events: { $sum: 1 }, actors: { $addToSet: '$actorHash' } } },
      { $project: { events: 1, actors: { $size: '$actors' } } },
      { $sort: { '_id.day': 1 } },
    ]),
    AnalyticsEvent.distinct('actorHash', { occurredAt: { $gte: since }, actorHash: { $ne: '' } }),
  ]);
  return {
    days: req.valid.query.days,
    uniqueUsers: actives.length,
    events: byName.map(x => ({ name: x._id.name, module: x._id.module, count: x.n })),
    daily: daily.map(x => ({ day: x._id.day, module: x._id.module, events: x.events, users: x.actors })),
  };
});

// Platform user directory (for support): who is behind an organization.
r.get('/users/:id', { ...SA, params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) }), summary: 'User with their memberships' }, async req => {
  const user = await User.findById(req.valid.params.id).lean();
  if (!user) throw errors.notFound('User');
  const memberships = await unscoped(() => OrganizationUser.find({ userId: user._id }).lean());
  return {
    id: String(user._id),
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    suspended: user.suspended,
    createdAt: user.createdAt,
    memberships: memberships.map(publicDoc),
  };
});


module.exports = r.router;
