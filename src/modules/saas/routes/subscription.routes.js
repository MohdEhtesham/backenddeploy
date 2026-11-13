const { createRouter } = require('../../core/router');
const { z, idParams, listQuery } = require('../../core/validation');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const { getState, usage } = require('../services/entitlements');
const { listPublicPlans, LIMIT_KEYS, FEATURE_KEYS } = require('../services/plans');
const subs = require('../services/subscriptions');
const { listOptions, paginate } = require('../../core/query');
const { paymentLimiter } = require('../../core/rateLimits');
const { audit } = require('../../core/audit');
const { publicDoc } = require('../../core/schema');

const r = createRouter({ prefix: '/pg/subscription', tag: 'Subscription' });

const PlanDto = z.object({
  planCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,32}$/),
  billingCycle: z.enum(['MONTHLY', 'YEARLY']).default('MONTHLY'),
  couponCode: z.string().trim().toUpperCase().max(32).optional(),
});

r.get('/', { permission: 'org.read', summary: 'Subscription, plan, entitlements & usage' }, async req => {
  const [state, counts] = await Promise.all([getState(req.ctx.orgId), usage(req.ctx.orgId)]);
  const sub = state.subscription || {};
  return {
    status: state.status,
    writable: state.writable,
    planCode: sub.planCode || null,
    plan: state.plan ? publicDoc(state.plan) : null,
    billingCycle: sub.billingCycle || null,
    trialEndsAt: sub.trialEndsAt || null,
    trialDaysLeft: state.trialDaysLeft,
    currentPeriodStart: sub.currentPeriodStart || null,
    currentPeriodEnd: sub.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    graceEndsAt: state.graceEndsAt,
    entitlements: state.entitlements,
    usage: Object.keys(LIMIT_KEYS).map(key => ({ key, label: LIMIT_KEYS[key], used: counts[key], limit: state.entitlements.limits[key] ?? -1 })),
    features: Object.keys(FEATURE_KEYS).map(key => ({ key, label: FEATURE_KEYS[key], enabled: state.entitlements.features[key] === true })),
    history: (sub.history || []).slice(-20).reverse(),
  };
});

r.get('/plans', { auth: 'user', summary: 'Public plans' }, async () => ({
  plans: await listPublicPlans(),
  catalog: { limits: LIMIT_KEYS, features: FEATURE_KEYS },
}));

r.post('/quote', { permission: 'org.billing.manage', body: PlanDto, write: false, summary: 'Price a plan (with coupon)' }, async req => {
  const q = await subs.quote(req.valid.body);
  return {
    planCode: q.plan.code,
    planName: q.plan.name,
    billingCycle: q.billingCycle,
    listAmount: q.listAmount,
    discount: q.discount,
    amount: q.amount,
    couponCode: q.coupon ? q.coupon.code : null,
  };
});

// Checkout stays available while the subscription is lapsed so owners can pay.
r.post(
  '/checkout',
  { permission: 'org.billing.manage', body: PlanDto, subscription: false, middleware: [paymentLimiter], summary: 'Start plan checkout' },
  async req => {
    const result = await subs.startCheckout(req, req.valid.body);
    audit(req, {
      action: result.activated ? 'subscription.activate' : 'subscription.checkout',
      entityType: 'Subscription',
      entityId: req.ctx.orgId,
      summary: `${req.valid.body.planCode} (${req.valid.body.billingCycle})`,
    });
    return result;
  },
);

r.get(
  '/payments',
  { permission: 'org.billing.manage', query: listQuery({ status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'REFUNDED']).optional() }), summary: 'Billing history' },
  async req => {
    const q = req.valid.query;
    const filter = { organizationId: req.ctx.orgId, ...(q.status ? { status: q.status } : {}) };
    return paginate(SubscriptionPayment, filter, listOptions(q, { sortable: ['createdAt', 'amount'] }));
  },
);

// Polled by the app after returning from checkout; verifies with the gateway.
r.get('/payments/:id', { permission: 'org.billing.manage', params: idParams, summary: 'Billing payment status (verified server-side)' }, async req =>
  publicDoc(await subs.reconcileSubscriptionPayment(req.ctx.orgId, req.valid.params.id)),
);

r.post('/cancel', { permission: 'org.billing.manage', subscription: false, summary: 'Cancel at period end' }, async req => {
  const state = await subs.cancelAtPeriodEnd(req.ctx.orgId, req.user._id);
  audit(req, { action: 'subscription.cancel', entityType: 'Subscription', entityId: req.ctx.orgId });
  return { status: state.status, cancelAtPeriodEnd: Boolean(state.subscription && state.subscription.cancelAtPeriodEnd) };
});

r.post('/resume', { permission: 'org.billing.manage', summary: 'Undo a scheduled cancellation' }, async req => {
  const state = await subs.resume(req.ctx.orgId, req.user._id);
  audit(req, { action: 'subscription.resume', entityType: 'Subscription', entityId: req.ctx.orgId });
  return { status: state.status, cancelAtPeriodEnd: false };
});

module.exports = r.router;
