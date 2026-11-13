const FeatureFlag = require('../models/FeatureFlag');

let cache = { at: 0, flags: [] };

const loadFlags = async () => {
  if (Date.now() - cache.at < 30 * 1000) return cache.flags;
  const flags = await FeatureFlag.find({}).lean();
  cache = { at: Date.now(), flags };
  return flags;
};

const isEnabledFor = (flag, organizationId) => {
  if (organizationId && (flag.disabledOrgIds || []).includes(organizationId)) return false;
  if (organizationId && (flag.enabledOrgIds || []).includes(organizationId)) return true;
  return Boolean(flag.enabled);
};

/** { flagKey: boolean } evaluated for an organization. */
const flagsFor = async organizationId => {
  const flags = await loadFlags();
  return Object.fromEntries(flags.map(f => [f.key, isEnabledFor(f, organizationId)]));
};

const invalidateFlags = () => {
  cache = { at: 0, flags: [] };
};

module.exports = { flagsFor, isEnabledFor, invalidateFlags };
