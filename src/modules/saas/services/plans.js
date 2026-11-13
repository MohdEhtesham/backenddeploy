const SubscriptionPlan = require('../models/SubscriptionPlan');
const { publicDoc } = require('../../core/schema');

// Entitlement vocabulary (labels for UIs). Enforcement is by key; the
// VALUES live in each plan document and are editable by the super admin.
const LIMIT_KEYS = {
  maxProperties: 'Properties',
  maxBeds: 'Beds',
  maxUsers: 'Team members',
  maxTenants: 'Active tenants',
};

const FEATURE_KEYS = {
  onlinePayments: 'Online rent collection',
  notifications: 'SMS / WhatsApp / email notifications',
  staffManagement: 'Staff, attendance & task assignment',
  messManagement: 'Mess menu & meal tracking',
  visitorManagement: 'Visitor gate passes',
  expenseManagement: 'Expense tracking',
  documentStorage: 'KYC document storage',
  advancedReports: 'Advanced reports & analytics',
  exportReports: 'CSV exports',
  prioritySupport: 'Priority support',
};

const allFeatures = value => Object.fromEntries(Object.keys(FEATURE_KEYS).map(k => [k, value]));

// Seeded once; never overwritten afterwards (the super admin owns them).
const DEFAULT_PLANS = [
  {
    code: 'FREE',
    name: 'Free',
    tagline: 'For a single small PG getting started',
    priceMonthly: 0,
    priceYearly: 0,
    sortOrder: 0,
    limits: { maxProperties: 1, maxBeds: 20, maxUsers: 2, maxTenants: 20 },
    features: {
      ...allFeatures(false),
      visitorManagement: true,
      expenseManagement: true,
      documentStorage: true,
    },
  },
  {
    code: 'STARTER',
    name: 'Starter',
    tagline: 'Online rent collection for growing PGs',
    priceMonthly: 999,
    priceYearly: 9990,
    sortOrder: 1,
    limits: { maxProperties: 2, maxBeds: 100, maxUsers: 5, maxTenants: 100 },
    features: {
      ...allFeatures(true),
      staffManagement: false,
      advancedReports: false,
      prioritySupport: false,
    },
  },
  {
    code: 'BUSINESS',
    name: 'Business',
    tagline: 'Everything to run multiple properties',
    priceMonthly: 2499,
    priceYearly: 24990,
    sortOrder: 2,
    highlight: true,
    limits: { maxProperties: 10, maxBeds: 500, maxUsers: 25, maxTenants: 500 },
    features: { ...allFeatures(true), prioritySupport: false },
  },
  {
    code: 'ENTERPRISE',
    name: 'Enterprise',
    tagline: 'Unlimited scale with priority support',
    priceMonthly: 7999,
    priceYearly: 79990,
    sortOrder: 3,
    limits: { maxProperties: -1, maxBeds: -1, maxUsers: -1, maxTenants: -1 },
    features: allFeatures(true),
  },
];

const seedPlans = async () => {
  for (const plan of DEFAULT_PLANS) {
    const exists = await SubscriptionPlan.exists({ code: plan.code });
    if (!exists) await SubscriptionPlan.create(plan);
  }
};

let cache = { at: 0, byCode: new Map() };

const loadPlans = async () => {
  if (Date.now() - cache.at < 30 * 1000 && cache.byCode.size) return cache.byCode;
  const plans = await SubscriptionPlan.find({}).lean();
  cache = { at: Date.now(), byCode: new Map(plans.map(p => [p.code, p])) };
  return cache.byCode;
};

const getPlan = async code => (await loadPlans()).get(String(code || '').toUpperCase()) || null;

const listPublicPlans = async () =>
  [...(await loadPlans()).values()]
    .filter(p => p.isActive && p.isPublic)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(publicDoc);

const invalidatePlans = () => {
  cache = { at: 0, byCode: new Map() };
};

/** Upgrade vs downgrade is decided by price, so it follows the data. */
const isUpgrade = (fromPlan, toPlan) =>
  Boolean(toPlan) && (!fromPlan || Number(toPlan.priceMonthly) > Number(fromPlan.priceMonthly));

const isFreePlan = plan => Boolean(plan) && Number(plan.priceMonthly) === 0 && Number(plan.priceYearly) === 0;

module.exports = {
  LIMIT_KEYS,
  FEATURE_KEYS,
  DEFAULT_PLANS,
  seedPlans,
  getPlan,
  listPublicPlans,
  invalidatePlans,
  isUpgrade,
  isFreePlan,
};
