const OrganizationUser = require('../saas/models/OrganizationUser');
const Organization = require('../saas/models/Organization');
const { permissionsFor } = require('../saas/services/rbac');
const { getState, assertFeature } = require('../saas/services/entitlements');
const { unscoped } = require('./scope');
const errors = require('./errors');

/**
 * Resolve the organization context for an authenticated request.
 *
 * The client may *select* an organization with the X-Org-Id header, but
 * it is only honoured after confirming an ACTIVE membership for this user.
 * Role, permissions, property scope and tenant/staff identity all come
 * from that membership row in the database.
 */
const orgContext = async (req, _res, next) => {
  try {
    const userId = String(req.user._id);
    const requested = String(req.get('x-org-id') || '').trim() || null;
    const memberships = await unscoped(() =>
      OrganizationUser.find({ userId, status: 'ACTIVE' }).lean(),
    );

    let membership = null;
    if (requested) {
      membership = memberships.find(m => m.organizationId === requested) || null;
      if (!membership) throw errors.forbidden('You are not a member of this organization.', 'NOT_A_MEMBER');
    } else if (memberships.length === 1) {
      membership = memberships[0];
    } else if (memberships.length === 0) {
      throw errors.forbidden('No PG organization is linked to this account yet.', 'NO_ORGANIZATION');
    } else {
      throw errors.badRequest('Select an organization (X-Org-Id header).', 'ORG_REQUIRED');
    }

    const org = await Organization.findOne({ _id: membership.organizationId }).lean();
    if (!org) throw errors.forbidden('This organization no longer exists.', 'NO_ORGANIZATION');
    if (org.status === 'SUSPENDED') {
      throw errors.forbidden(
        'This organization has been suspended. Please contact support.',
        'ORG_SUSPENDED',
      );
    }

    const permissions = await permissionsFor(membership);
    req.ctx = {
      ...(req.ctx || {}),
      orgId: org._id,
      org,
      membership,
      role: membership.role,
      permissions,
      propertyIds: membership.propertyIds && membership.propertyIds.length ? membership.propertyIds : null,
      tenantId: membership.tenantId || null,
      staffId: membership.staffId || null,
    };
    next();
  } catch (e) {
    next(e);
  }
};

const requirePermission = permission => (req, _res, next) => {
  if (!req.ctx || !req.ctx.permissions || !req.ctx.permissions.has(permission)) {
    return next(errors.forbidden('You do not have permission to perform this action.', 'PERMISSION_DENIED', { permission }));
  }
  next();
};

const requireAnyPermission = permissions => (req, _res, next) => {
  if (!req.ctx || !permissions.some(p => req.ctx.permissions.has(p))) {
    return next(
      errors.forbidden('You do not have permission to perform this action.', 'PERMISSION_DENIED', { permissions }),
    );
  }
  next();
};

const requireSuperAdmin = (req, _res, next) => {
  if (!req.auth || !req.auth.isSuperAdmin) return next(errors.forbidden('Super admin only.', 'SUPER_ADMIN_ONLY'));
  req.ctx = { ...(req.ctx || {}), role: 'SUPER_ADMIN', orgId: null };
  next();
};

/** Tenant self-service: the caller must be a TENANT linked to a tenant record. */
const requireTenantSelf = (req, _res, next) => {
  if (!req.ctx || req.ctx.role !== 'TENANT' || !req.ctx.tenantId) {
    return next(errors.forbidden('This section is only available to residents.', 'TENANT_ONLY'));
  }
  next();
};

/** Block mutations while the subscription is read-only (expired etc.). */
const requireWritableSubscription = async (req, _res, next) => {
  try {
    const state = await getState(req.ctx.orgId);
    req.ctx.subscription = state;
    if (!state.writable) {
      throw errors.paymentRequired(
        state.status === 'SUSPENDED'
          ? 'Your subscription is suspended. Please contact support.'
          : 'Your subscription is inactive. Renew your plan to make changes — your data remains available to view.',
        'SUBSCRIPTION_INACTIVE',
        { status: state.status },
      );
    }
    next();
  } catch (e) {
    next(e);
  }
};

const requireFeature = feature => async (req, _res, next) => {
  try {
    await assertFeature(req.ctx.orgId, feature);
    next();
  } catch (e) {
    next(e);
  }
};

// ---- Property scope -----------------------------------------------------------

/** Members limited to some properties may only touch those. */
const assertPropertyAccess = (req, propertyId) => {
  const allowed = req.ctx && req.ctx.propertyIds;
  if (allowed && propertyId && !allowed.includes(String(propertyId))) {
    throw errors.notFound('Property');
  }
};

/** Mongo filter fragment restricting a query to the caller's properties. */
const propertyScope = (req, field = 'propertyId', requested) => {
  const allowed = req.ctx && req.ctx.propertyIds;
  if (requested) {
    assertPropertyAccess(req, requested);
    return { [field]: requested };
  }
  return allowed ? { [field]: { $in: allowed } } : {};
};

module.exports = {
  orgContext,
  requirePermission,
  requireAnyPermission,
  requireSuperAdmin,
  requireTenantSelf,
  requireWritableSubscription,
  requireFeature,
  assertPropertyAccess,
  propertyScope,
};
