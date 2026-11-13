const Subscription = require('../models/Subscription');
const OrganizationUser = require('../models/OrganizationUser');
const PgProperty = require('../../pg/models/PgProperty');
const Bed = require('../../pg/models/Bed');
const Tenant = require('../../pg/models/Tenant');
const { getPlan, LIMIT_KEYS, FEATURE_KEYS } = require('./plans');
const { getSettings } = require('./settings');
const { nextLifecycle, isWritable, daysUntil, DAY_MS } = require('./lifecycle');
const { paymentRequired } = require('../../core/errors');

// Everything here is computed server-side from the database. Clients may
// display these values but can never influence them.

const mergeEntitlements = (plan, overrides) => ({
  limits: { ...((plan && plan.limits) || {}), ...((overrides && overrides.limits) || {}) },
  features: { ...((plan && plan.features) || {}), ...((overrides && overrides.features) || {}) },
});

/**
 * Load the org subscription, applying (and persisting) any lifecycle
 * transition that is due — so state is correct even if the scheduled job
 * hasn't run yet. Returns a lean document.
 */
const refreshSubscription = async (organizationId, now = new Date()) => {
  const sub = await Subscription.findOne({ organizationId }).lean();
  if (!sub) return null;
  const settings = await getSettings();
  const { changes, events } = nextLifecycle(sub, now, settings);
  if (!events.length) return sub;

  const updated = await Subscription.findOneAndUpdate(
    { organizationId, _id: sub._id, status: sub.status, planCode: sub.planCode },
    {
      $set: changes,
      $push: {
        history: {
          $each: events.map(event => ({
            event,
            at: now,
            fromStatus: sub.status,
            toStatus: changes.status || sub.status,
            fromPlan: sub.planCode,
            toPlan: changes.planCode || sub.planCode,
          })),
        },
      },
    },
    { new: true },
  ).lean();

  if (updated) {
    // Lazy require: subscription notifications depend on this module.
    require('./subscriptionEvents').onTransition(organizationId, sub, updated, events);
    return updated;
  }
  return Subscription.findOne({ organizationId }).lean();
};

/** Effective subscription state + entitlements for an organization. */
const getState = async (organizationId, now = new Date()) => {
  const subscription = await refreshSubscription(organizationId, now);
  if (!subscription) {
    return {
      subscription: null,
      plan: null,
      status: 'EXPIRED',
      writable: false,
      entitlements: { limits: {}, features: {} },
      trialDaysLeft: null,
      periodEndsAt: null,
      graceEndsAt: null,
    };
  }
  const plan = await getPlan(subscription.planCode);
  const settings = await getSettings();
  return {
    subscription,
    plan,
    status: subscription.status,
    writable: isWritable(subscription.status),
    entitlements: mergeEntitlements(plan, subscription.entitlementOverrides),
    trialDaysLeft: subscription.status === 'TRIAL' ? daysUntil(subscription.trialEndsAt, now) : null,
    periodEndsAt: subscription.currentPeriodEnd || null,
    graceEndsAt:
      subscription.status === 'PAST_DUE' && subscription.pastDueSince
        ? new Date(new Date(subscription.pastDueSince).getTime() + settings.graceDays * DAY_MS)
        : null,
  };
};

const hasFeature = async (organizationId, feature) => {
  const state = await getState(organizationId);
  return state.entitlements.features[feature] === true;
};

const assertFeature = async (organizationId, feature) => {
  const state = await getState(organizationId);
  if (state.entitlements.features[feature] !== true) {
    const label = FEATURE_KEYS[feature] || feature;
    const planName = state.plan ? state.plan.name : 'current';
    throw paymentRequired(`${label} is not included in your ${planName} plan. Upgrade to use it.`, 'FEATURE_NOT_IN_PLAN', {
      feature,
    });
  }
  return state;
};

const usageCount = async (organizationId, key) => {
  switch (key) {
    case 'maxProperties':
      return PgProperty.countDocuments({ organizationId });
    case 'maxBeds':
      return Bed.countDocuments({ organizationId });
    case 'maxUsers':
      return OrganizationUser.countDocuments({
        organizationId,
        role: { $ne: 'TENANT' },
        status: { $in: ['ACTIVE', 'INVITED'] },
      });
    case 'maxTenants':
      return Tenant.countDocuments({ organizationId, status: { $in: ['PROSPECT', 'ACTIVE', 'NOTICE'] } });
    default:
      return 0;
  }
};

const usage = async organizationId => {
  const keys = Object.keys(LIMIT_KEYS);
  const counts = await Promise.all(keys.map(k => usageCount(organizationId, k)));
  return Object.fromEntries(keys.map((k, i) => [k, counts[i]]));
};

/** Throw PLAN_LIMIT_REACHED if adding `adding` units would exceed the plan. */
const assertLimit = async (organizationId, key, adding = 1) => {
  const state = await getState(organizationId);
  const limit = state.entitlements.limits[key];
  if (limit === undefined || limit === null || Number(limit) < 0) return;
  const current = await usageCount(organizationId, key);
  if (current + adding > Number(limit)) {
    const label = (LIMIT_KEYS[key] || key).toLowerCase();
    const planName = state.plan ? state.plan.name : 'current';
    throw paymentRequired(
      `Your ${planName} plan allows up to ${limit} ${label}. Upgrade your plan to add more.`,
      'PLAN_LIMIT_REACHED',
      { key, limit: Number(limit), current, adding },
    );
  }
};

module.exports = {
  mergeEntitlements,
  refreshSubscription,
  getState,
  hasFeature,
  assertFeature,
  assertLimit,
  usage,
  usageCount,
};
