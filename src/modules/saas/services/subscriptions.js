const env = require('../../../config/env');
const Subscription = require('../models/Subscription');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const Coupon = require('../models/Coupon');
const Organization = require('../models/Organization');
const { getPlan, isUpgrade, isFreePlan, LIMIT_KEYS } = require('./plans');
const { getSettings } = require('./settings');
const { getState, usage, refreshSubscription } = require('./entitlements');
const { memberUserIds } = require('./members');
const { getGateway } = require('../../payments/gateway');
const { withTransaction } = require('../../core/tx');
const { unscoped } = require('../../core/scope');
const { nextNumber } = require('../../core/counters');
const { round2, max0 } = require('../../core/money');
const D = require('../../core/dates');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');
const { track } = require('../../analytics/track');

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- Coupons & quotes -------------------------------------------------------

const validateCoupon = async (code, planCode, billingCycle, now = new Date()) => {
  const coupon = await Coupon.findOne({ code: String(code).toUpperCase().trim(), active: true }).lean();
  if (!coupon) throw errors.badRequest('This coupon code is not valid.', 'COUPON_INVALID');
  if (coupon.validFrom && now < coupon.validFrom) throw errors.badRequest('This coupon is not active yet.', 'COUPON_INVALID');
  if (coupon.validUntil && now > coupon.validUntil) throw errors.badRequest('This coupon has expired.', 'COUPON_EXPIRED');
  if (coupon.maxRedemptions > 0 && coupon.redemptions >= coupon.maxRedemptions) {
    throw errors.badRequest('This coupon has been fully redeemed.', 'COUPON_EXHAUSTED');
  }
  if (coupon.planCodes && coupon.planCodes.length && !coupon.planCodes.includes(planCode)) {
    throw errors.badRequest('This coupon does not apply to the selected plan.', 'COUPON_NOT_APPLICABLE');
  }
  if (coupon.billingCycles && coupon.billingCycles.length && !coupon.billingCycles.includes(billingCycle)) {
    throw errors.badRequest('This coupon does not apply to this billing cycle.', 'COUPON_NOT_APPLICABLE');
  }
  return coupon;
};

const quote = async ({ planCode, billingCycle = 'MONTHLY', couponCode }) => {
  const plan = await getPlan(planCode);
  if (!plan || !plan.isActive || plan.deletedAt) throw errors.notFound('Plan');
  const listAmount = round2(billingCycle === 'YEARLY' ? plan.priceYearly : plan.priceMonthly);
  let discount = 0;
  let coupon = null;
  if (couponCode) {
    coupon = await validateCoupon(couponCode, plan.code, billingCycle);
    discount =
      coupon.type === 'PERCENT'
        ? round2((listAmount * Math.min(100, coupon.value)) / 100)
        : round2(Math.min(coupon.value, listAmount));
  }
  return { plan, billingCycle, listAmount, discount, amount: max0(listAmount - discount), coupon };
};

/** Refuse a plan whose limits the organization already exceeds. */
const assertUsageFits = async (organizationId, plan, overrides) => {
  const current = await usage(organizationId);
  const limits = { ...(plan.limits || {}), ...((overrides && overrides.limits) || {}) };
  const over = Object.keys(LIMIT_KEYS).filter(k => {
    const limit = limits[k];
    return limit !== undefined && limit !== null && Number(limit) >= 0 && current[k] > Number(limit);
  });
  if (over.length) {
    throw errors.conflict(
      `Your current usage exceeds the ${plan.name} plan (${over
        .map(k => `${LIMIT_KEYS[k].toLowerCase()}: ${current[k]}/${limits[k]}`)
        .join(', ')}). Reduce usage or choose a bigger plan.`,
      'PLAN_DOWNGRADE_BLOCKED',
      { usage: current, limits },
    );
  }
};

const redeemCoupon = async (code, session) => {
  if (!code) return;
  await Coupon.updateOne(
    {
      code,
      $or: [{ maxRedemptions: 0 }, { $expr: { $lt: ['$redemptions', '$maxRedemptions'] } }],
    },
    { $inc: { redemptions: 1 } },
    { session: session || undefined },
  );
};

// ---- Activation (server-side only) -----------------------------------------

/**
 * Switch the organization to `planCode` as ACTIVE. Called only after a
 * verified payment, a zero-amount checkout, or a super admin action.
 */
const activatePlan = async (organizationId, { planCode, billingCycle = 'MONTHLY', paymentId = null, couponCode = null, userId = null, periodEnd = null, note = '' }, session = null) => {
  const sub = await Subscription.findOne({ organizationId }).session(session);
  if (!sub) throw errors.notFound('Subscription');
  const plan = await getPlan(planCode);
  if (!plan) throw errors.notFound('Plan');
  const fromPlan = await getPlan(sub.planCode);
  const now = new Date();

  const renewal =
    sub.status === 'ACTIVE' && sub.planCode === plan.code && sub.currentPeriodEnd && sub.currentPeriodEnd > now;
  const start = renewal ? sub.currentPeriodEnd : now;
  let end = null;
  if (periodEnd) end = new Date(periodEnd);
  else if (!isFreePlan(plan)) end = D.addMonths(start, billingCycle === 'YEARLY' ? 12 : 1);

  const event = renewal
    ? 'renewed'
    : sub.planCode === plan.code
    ? 'activated'
    : isUpgrade(fromPlan, plan)
    ? 'upgraded'
    : 'downgraded';

  const fromStatus = sub.status;
  sub.history.push({
    event,
    fromStatus,
    toStatus: 'ACTIVE',
    fromPlan: sub.planCode,
    toPlan: plan.code,
    byUserId: userId,
    note,
  });
  sub.planCode = plan.code;
  sub.status = 'ACTIVE';
  sub.billingCycle = billingCycle;
  if (!renewal) sub.currentPeriodStart = now;
  sub.currentPeriodEnd = end;
  sub.cancelAtPeriodEnd = false;
  sub.cancelledAt = null;
  sub.pastDueSince = null;
  sub.suspendedAt = null;
  sub.suspendedReason = '';
  if (couponCode) sub.couponCode = couponCode;
  if (paymentId) sub.lastPaymentId = paymentId;
  await sub.save({ session: session || undefined });

  return { subscription: sub.toJSON(), event, fromStatus, fromPlanCode: fromPlan ? fromPlan.code : null };
};

const afterActivation = (organizationId, result, userId) => {
  const { event, fromStatus } = result;
  const plan = result.subscription.planCode;
  if (event === 'upgraded') {
    track('subscription_upgraded', { userId, organizationId, props: { plan, from: result.fromPlanCode || '' } });
  } else if (event === 'activated' || (fromStatus !== 'ACTIVE' && event !== 'renewed')) {
    track('subscription_started', { userId, organizationId, props: { plan } });
  }
  memberUserIds(organizationId, ['OWNER'])
    .then(userIds =>
      notify({
        userIds,
        organizationId,
        type: 'subscription',
        title: event === 'renewed' ? 'Subscription renewed' : 'Plan activated',
        body: `Your organization is now on the ${plan} plan.`,
        data: { route: 'subscription' },
      }),
    )
    .catch(() => {});
};

// ---- Checkout ---------------------------------------------------------------

const startCheckout = async (req, { planCode, billingCycle, couponCode }) => {
  const organizationId = req.ctx.orgId;
  const q = await quote({ planCode, billingCycle, couponCode });
  if (!q.plan.isPublic && !req.auth.isSuperAdmin) throw errors.notFound('Plan');
  const sub = await Subscription.findOne({ organizationId }).lean();
  await assertUsageFits(organizationId, q.plan, sub && sub.entitlementOverrides);

  if (q.amount === 0) {
    const result = await withTransaction(async session => {
      const r = await activatePlan(
        organizationId,
        { planCode: q.plan.code, billingCycle, couponCode: q.coupon ? q.coupon.code : null, userId: req.user._id },
        session,
      );
      if (q.coupon) await redeemCoupon(q.coupon.code, session);
      return r;
    });
    afterActivation(organizationId, result, req.user._id);
    return { activated: true, subscription: result.subscription };
  }

  const gateway = getGateway();
  if (!gateway.isConfigured()) {
    throw errors.unavailable(
      'Online payments are not configured on this server yet. Please contact support to upgrade.',
      'PAYMENTS_NOT_CONFIGURED',
    );
  }

  // Reuse an unexpired pending checkout for the identical order.
  const existing = await SubscriptionPayment.findOne({
    organizationId,
    status: 'PENDING',
    planCode: q.plan.code,
    billingCycle,
    amount: q.amount,
    'gateway.expiresAt': { $gt: new Date(Date.now() + 5 * 60 * 1000) },
  }).lean();
  if (existing && existing.gateway && existing.gateway.checkoutUrl) {
    return { activated: false, paymentId: existing._id, checkoutUrl: existing.gateway.checkoutUrl, amount: existing.amount };
  }

  const org = await Organization.findById(organizationId).lean();
  const payment = await SubscriptionPayment.create({
    organizationId,
    planCode: q.plan.code,
    billingCycle,
    listAmount: q.listAmount,
    discount: q.discount,
    amount: q.amount,
    couponCode: q.coupon ? q.coupon.code : null,
    initiatedBy: req.user._id,
  });

  const expiresAt = new Date(Date.now() + env.PAYMENT_LINK_EXPIRY_MINUTES * 60 * 1000);
  let checkout;
  try {
    checkout = await gateway.createCheckout({
      referenceId: payment._id,
      amount: q.amount,
      description: `Aabroo ${q.plan.name} plan (${billingCycle.toLowerCase()})`,
      customer: { name: org.name, phone: req.user.phone, email: req.user.email },
      notes: { kind: 'subscription', organizationId, paymentId: payment._id },
      callbackUrl: `${env.PUBLIC_API_URL}/api/payments/return`,
      expireBy: expiresAt,
    });
  } catch (e) {
    await SubscriptionPayment.updateOne(
      { _id: payment._id, organizationId },
      { $set: { status: 'FAILED', failureReason: e.message } },
    );
    throw e;
  }

  await SubscriptionPayment.updateOne(
    { _id: payment._id, organizationId },
    { $set: { gateway: { provider: gateway.name, ref: checkout.ref, checkoutUrl: checkout.url, expiresAt } } },
  );
  return { activated: false, paymentId: payment._id, checkoutUrl: checkout.url, amount: q.amount };
};

/**
 * Confirm a subscription payment after the gateway (verified webhook or
 * server-to-server check) reports it paid. Idempotent.
 */
const confirmSubscriptionPayment = async ({ ref, amountPaid, currency, gatewayPaymentId }) => {
  const payment = await unscoped(() => SubscriptionPayment.findOne({ 'gateway.ref': ref }).lean());
  if (!payment) return { matched: false };
  if (payment.status === 'SUCCEEDED') return { matched: true, duplicate: true, paymentId: payment._id };

  const organizationId = payment.organizationId;
  if (round2(amountPaid) !== round2(payment.amount) || String(currency || 'INR') !== payment.currency) {
    await SubscriptionPayment.updateOne(
      { _id: payment._id, organizationId, status: 'PENDING' },
      { $set: { status: 'FAILED', failureReason: `Amount mismatch: paid ${amountPaid} ${currency}, expected ${payment.amount}` } },
    );
    console.error('[billing] amount mismatch on subscription payment', payment._id);
    return { matched: true, mismatch: true, paymentId: payment._id };
  }

  const result = await withTransaction(async session => {
    // Conditional claim: exactly one caller moves PENDING → SUCCEEDED.
    const claimed = await SubscriptionPayment.findOneAndUpdate(
      { _id: payment._id, organizationId, status: 'PENDING' },
      { $set: { status: 'SUCCEEDED', paidAt: new Date(), 'gateway.paymentId': gatewayPaymentId || null } },
      { new: true, session },
    );
    if (!claimed) return null;
    const r = await activatePlan(
      organizationId,
      { planCode: payment.planCode, billingCycle: payment.billingCycle, paymentId: payment._id, couponCode: payment.couponCode },
      session,
    );
    await SubscriptionPayment.updateOne(
      { _id: payment._id, organizationId },
      {
        $set: {
          invoiceNumber: await nextNumber(organizationId, 'SUBINV', 'SUB', session),
          periodStart: r.subscription.currentPeriodStart,
          periodEnd: r.subscription.currentPeriodEnd,
        },
      },
      { session },
    );
    if (payment.couponCode) await redeemCoupon(payment.couponCode, session);
    return r;
  });

  if (!result) return { matched: true, duplicate: true, paymentId: payment._id };
  afterActivation(organizationId, result, payment.initiatedBy);
  return { matched: true, activated: true, paymentId: payment._id };
};

const closeSubscriptionCheckout = async (ref, status) => {
  const payment = await unscoped(() => SubscriptionPayment.findOne({ 'gateway.ref': ref }).lean());
  if (!payment) return { matched: false };
  await SubscriptionPayment.updateOne(
    { _id: payment._id, organizationId: payment.organizationId, status: 'PENDING' },
    { $set: { status: status === 'expired' ? 'EXPIRED' : 'FAILED', failureReason: `Checkout ${status}` } },
  );
  return { matched: true };
};

/** Ask the gateway directly about a pending subscription payment. */
const reconcileSubscriptionPayment = async (organizationId, paymentId) => {
  const payment = await SubscriptionPayment.findOne({ _id: paymentId, organizationId }).lean();
  if (!payment) throw errors.notFound('Payment');
  if (payment.status !== 'PENDING' || !payment.gateway || !payment.gateway.ref) return payment;
  const gateway = getGateway();
  if (!gateway.isConfigured()) return payment;
  try {
    const remote = await gateway.fetchCheckout(payment.gateway.ref);
    if (remote.status === 'paid') {
      await confirmSubscriptionPayment({
        ref: payment.gateway.ref,
        amountPaid: remote.amountPaid,
        currency: remote.currency,
        gatewayPaymentId: remote.gatewayPaymentId,
      });
    } else if (remote.status === 'expired' || remote.status === 'cancelled') {
      await closeSubscriptionCheckout(payment.gateway.ref, remote.status);
    }
  } catch (e) {
    console.warn('[billing] reconcile failed', e.message);
  }
  return SubscriptionPayment.findOne({ _id: paymentId, organizationId }).lean();
};

// ---- Self-service & admin actions --------------------------------------------

const cancelAtPeriodEnd = async (organizationId, userId) => {
  const sub = await refreshSubscription(organizationId);
  if (!sub) throw errors.notFound('Subscription');
  if (sub.status === 'TRIAL') {
    await Subscription.updateOne(
      { organizationId, _id: sub._id },
      {
        $set: { status: 'CANCELLED', cancelledAt: new Date() },
        $push: { history: { event: 'cancelled', fromStatus: 'TRIAL', toStatus: 'CANCELLED', byUserId: userId } },
      },
    );
  } else if (sub.status === 'ACTIVE' && sub.currentPeriodEnd) {
    await Subscription.updateOne(
      { organizationId, _id: sub._id },
      {
        $set: { cancelAtPeriodEnd: true },
        $push: { history: { event: 'cancel_scheduled', fromStatus: 'ACTIVE', toStatus: 'ACTIVE', byUserId: userId } },
      },
    );
  } else {
    throw errors.conflict('This subscription cannot be cancelled in its current state.', 'SUBSCRIPTION_STATE');
  }
  return getState(organizationId);
};

const resume = async (organizationId, userId) => {
  const sub = await refreshSubscription(organizationId);
  if (!sub || sub.status !== 'ACTIVE' || !sub.cancelAtPeriodEnd) {
    throw errors.conflict('Nothing to resume.', 'SUBSCRIPTION_STATE');
  }
  await Subscription.updateOne(
    { organizationId, _id: sub._id },
    {
      $set: { cancelAtPeriodEnd: false },
      $push: { history: { event: 'cancel_reverted', fromStatus: 'ACTIVE', toStatus: 'ACTIVE', byUserId: userId } },
    },
  );
  return getState(organizationId);
};

/** Super admin: extend (or restart) a trial by `days`. */
const extendTrial = async (organizationId, days, userId) => {
  const sub = await Subscription.findOne({ organizationId });
  if (!sub) throw errors.notFound('Subscription');
  if (!['TRIAL', 'EXPIRED', 'CANCELLED'].includes(sub.status)) {
    throw errors.conflict('Only trial or lapsed subscriptions can get a trial extension.', 'SUBSCRIPTION_STATE');
  }
  const base = sub.trialEndsAt && sub.trialEndsAt > new Date() ? sub.trialEndsAt.getTime() : Date.now();
  sub.history.push({ event: 'trial_extended', fromStatus: sub.status, toStatus: 'TRIAL', byUserId: userId, note: `+${days} days` });
  sub.status = 'TRIAL';
  sub.trialEndsAt = new Date(base + days * DAY_MS);
  sub.cancelledAt = null;
  await sub.save();
  return sub.toJSON();
};

const suspend = async (organizationId, reason, userId) => {
  const sub = await Subscription.findOne({ organizationId });
  if (!sub) throw errors.notFound('Subscription');
  sub.history.push({ event: 'suspended', fromStatus: sub.status, toStatus: 'SUSPENDED', byUserId: userId, note: reason });
  sub.status = 'SUSPENDED';
  sub.suspendedAt = new Date();
  sub.suspendedReason = reason || '';
  await sub.save();
  return sub.toJSON();
};

/** Super admin: lift a suspension, restoring the state dates imply. */
const reactivate = async (organizationId, userId) => {
  const sub = await Subscription.findOne({ organizationId });
  if (!sub) throw errors.notFound('Subscription');
  if (sub.status !== 'SUSPENDED') throw errors.conflict('Subscription is not suspended.', 'SUBSCRIPTION_STATE');
  const now = new Date();
  let status = 'EXPIRED';
  if (sub.trialEndsAt && sub.trialEndsAt > now && !sub.currentPeriodEnd) status = 'TRIAL';
  else if (!sub.currentPeriodEnd || sub.currentPeriodEnd > now) status = 'ACTIVE';
  if (status === 'ACTIVE' && !sub.currentPeriodEnd) {
    const plan = await getPlan(sub.planCode);
    if (!isFreePlan(plan)) status = 'EXPIRED';
  }
  sub.history.push({ event: 'reactivated', fromStatus: 'SUSPENDED', toStatus: status, byUserId: userId });
  sub.status = status;
  sub.suspendedAt = null;
  sub.suspendedReason = '';
  await sub.save();
  return sub.toJSON();
};

const setOverrides = async (organizationId, overrides, userId) => {
  const sub = await Subscription.findOne({ organizationId });
  if (!sub) throw errors.notFound('Subscription');
  sub.entitlementOverrides = { limits: overrides.limits || {}, features: overrides.features || {} };
  sub.history.push({ event: 'overrides_updated', fromStatus: sub.status, toStatus: sub.status, byUserId: userId });
  await sub.save();
  return sub.toJSON();
};

/** Initial subscription for a new organization. */
const createInitialSubscription = async (organizationId, { trial }, session) => {
  const settings = await getSettings();
  const now = new Date();
  if (trial) {
    const plan = (await getPlan(settings.trialPlanCode)) || (await getPlan('BUSINESS'));
    const days = plan && plan.trialDays !== null && plan.trialDays !== undefined ? plan.trialDays : settings.trialDays;
    const [doc] = await Subscription.create(
      [
        {
          organizationId,
          planCode: plan ? plan.code : settings.trialPlanCode,
          status: 'TRIAL',
          trialEndsAt: new Date(now.getTime() + days * DAY_MS),
          history: [{ event: 'trial_started', toStatus: 'TRIAL', toPlan: plan ? plan.code : settings.trialPlanCode, note: `${days} days` }],
        },
      ],
      { session: session || undefined },
    );
    return doc;
  }
  const [doc] = await Subscription.create(
    [
      {
        organizationId,
        planCode: settings.freePlanCode,
        status: 'ACTIVE',
        currentPeriodStart: now,
        currentPeriodEnd: null,
        history: [{ event: 'activated', toStatus: 'ACTIVE', toPlan: settings.freePlanCode, note: 'No trial (repeat organization)' }],
      },
    ],
    { session: session || undefined },
  );
  return doc;
};

module.exports = {
  validateCoupon,
  quote,
  assertUsageFits,
  activatePlan,
  afterActivation,
  startCheckout,
  confirmSubscriptionPayment,
  closeSubscriptionCheckout,
  reconcileSubscriptionPayment,
  cancelAtPeriodEnd,
  resume,
  extendTrial,
  suspend,
  reactivate,
  setOverrides,
  createInitialSubscription,
};
