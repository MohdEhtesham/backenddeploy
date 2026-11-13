const env = require('../../../config/env');
const PlatformSetting = require('../models/PlatformSetting');

// Live platform configuration. Env vars seed the defaults; values saved by
// the super admin in saas_platform_settings win.
const DEFAULTS = () => ({
  trialDays: env.SAAS_TRIAL_DAYS,
  trialPlanCode: env.SAAS_TRIAL_PLAN,
  freePlanCode: 'FREE',
  graceDays: env.SAAS_GRACE_DAYS,
  // What happens when a trial ends unpaid: EXPIRE (read-only until a plan is
  // chosen) or DOWNGRADE_TO_FREE.
  trialExpiryAction: env.SAAS_TRIAL_EXPIRY_ACTION === 'DOWNGRADE_TO_FREE' ? 'DOWNGRADE_TO_FREE' : 'EXPIRE',
  maxOrganizationsPerOwner: 3,
  supportEmail: 'support@abroo.app',
});

const VALIDATORS = {
  trialDays: v => Number.isInteger(v) && v >= 0 && v <= 365,
  trialPlanCode: v => typeof v === 'string' && /^[A-Z0-9_]{2,32}$/.test(v),
  freePlanCode: v => typeof v === 'string' && /^[A-Z0-9_]{2,32}$/.test(v),
  graceDays: v => Number.isInteger(v) && v >= 0 && v <= 90,
  trialExpiryAction: v => ['EXPIRE', 'DOWNGRADE_TO_FREE'].includes(v),
  maxOrganizationsPerOwner: v => Number.isInteger(v) && v >= 1 && v <= 100,
  supportEmail: v => typeof v === 'string' && v.length <= 160,
};

let cache = null;
let cacheAt = 0;

const getSettings = async () => {
  if (cache && Date.now() - cacheAt < 30 * 1000) return cache;
  const rows = await PlatformSetting.find({}).lean();
  const merged = { ...DEFAULTS() };
  for (const r of rows) if (r._id in merged) merged[r._id] = r.value;
  cache = merged;
  cacheAt = Date.now();
  return merged;
};

const updateSettings = async (patch, userId) => {
  const invalid = Object.entries(patch).filter(([k, v]) => !VALIDATORS[k] || !VALIDATORS[k](v));
  if (invalid.length) {
    const { badRequest } = require('../../core/errors');
    throw badRequest(`Invalid setting(s): ${invalid.map(([k]) => k).join(', ')}`);
  }
  await Promise.all(
    Object.entries(patch).map(([key, value]) =>
      PlatformSetting.updateOne({ _id: key }, { $set: { value, updatedBy: userId || null } }, { upsert: true }),
    ),
  );
  cache = null;
  return getSettings();
};

const invalidateSettings = () => {
  cache = null;
};

module.exports = { getSettings, updateSettings, invalidateSettings, DEFAULTS };
