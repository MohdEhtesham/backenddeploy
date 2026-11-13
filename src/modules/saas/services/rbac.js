const Role = require('../models/Role');
const Permission = require('../models/Permission');
const { PERMISSIONS, ROLE_DEFS, moduleOf } = require('../../core/permissions');

// Permissions are always resolved from the database (seeded from the
// catalog), cached briefly in-process.

const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, byKey: new Map() };

/**
 * Idempotently sync the permission catalog and the system roles. System
 * role permission sets are reset to the catalog on every boot so that a
 * code update granting a new permission reaches existing deployments.
 */
const seedRbac = async () => {
  await Promise.all(
    Object.entries(PERMISSIONS).map(([key, description]) =>
      Permission.updateOne({ key }, { $set: { description, module: moduleOf(key) } }, { upsert: true }),
    ),
  );
  await Promise.all(
    Object.entries(ROLE_DEFS).map(([key, def]) =>
      Role.updateOne(
        { organizationId: null, key },
        { $set: { name: def.name, description: def.description, permissions: def.permissions, isSystem: true } },
        { upsert: true },
      ),
    ),
  );
  invalidateRbacCache();
};

const invalidateRbacCache = () => {
  cache = { at: 0, byKey: new Map() };
};

const loadRoles = async () => {
  if (Date.now() - cache.at < CACHE_TTL_MS && cache.byKey.size) return cache.byKey;
  const roles = await Role.find({ organizationId: null }).lean();
  const byKey = new Map(roles.map(r => [r.key, new Set(r.permissions || [])]));
  cache = { at: Date.now(), byKey };
  return byKey;
};

/** Set of permission keys for a membership row. */
const permissionsFor = async membership => {
  const roles = await loadRoles();
  const set = roles.get(membership.role);
  if (set) return new Set(set);
  // Fall back to the in-code defaults if the DB was never seeded.
  const def = ROLE_DEFS[membership.role];
  return new Set(def ? def.permissions : []);
};

module.exports = { seedRbac, permissionsFor, invalidateRbacCache };
