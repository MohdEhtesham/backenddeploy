const { createRouter } = require('../../core/router');
const { z, text, phone, email } = require('../../core/validation');
const OrganizationUser = require('../models/OrganizationUser');
const Organization = require('../models/Organization');
const { permissionsFor } = require('../services/rbac');
const { getState } = require('../services/entitlements');
const { flagsFor } = require('../services/featureFlags');
const { createOrganization } = require('../services/organizations');
const { LIMIT_KEYS, FEATURE_KEYS } = require('../services/plans');
const { unscoped } = require('../../core/scope');
const { audit } = require('../../core/audit');
const errors = require('../../core/errors');

const r = createRouter({ prefix: '/pg', tag: 'Context' });

const summarizeState = state => ({
  planCode: state.subscription ? state.subscription.planCode : null,
  planName: state.plan ? state.plan.name : null,
  status: state.status,
  writable: state.writable,
  trialEndsAt: state.subscription ? state.subscription.trialEndsAt : null,
  trialDaysLeft: state.trialDaysLeft,
  currentPeriodEnd: state.periodEndsAt,
  cancelAtPeriodEnd: Boolean(state.subscription && state.subscription.cancelAtPeriodEnd),
  graceEndsAt: state.graceEndsAt,
  entitlements: state.entitlements,
});

/**
 * Everything the app needs to render the PG experience for the signed-in
 * user: organizations they belong to, the active one (from X-Org-Id when
 * valid), role, permissions, subscription and feature flags — all computed
 * server-side.
 */
r.get('/me/context', { auth: 'user', summary: 'PG context for the signed-in user' }, async req => {
  const userId = String(req.user._id);
  const memberships = await unscoped(() =>
    OrganizationUser.find({ userId, status: { $in: ['ACTIVE', 'INVITED'] } }).lean(),
  );
  const orgIds = [...new Set(memberships.map(m => m.organizationId))];
  const orgs = await Organization.find({ _id: { $in: orgIds } }).select('name slug logoUrl status address').lean();
  const orgOf = new Map(orgs.map(o => [o._id, o]));

  const active = memberships.filter(m => m.status === 'ACTIVE' && orgOf.has(m.organizationId));
  const requested = String(req.get('x-org-id') || '');
  const current = active.find(m => m.organizationId === requested) || (active.length === 1 ? active[0] : null) || active[0] || null;

  let activeContext = null;
  if (current) {
    const org = orgOf.get(current.organizationId);
    const [permissions, state, flags] = await Promise.all([
      permissionsFor(current),
      getState(current.organizationId),
      flagsFor(current.organizationId),
    ]);
    activeContext = {
      organization: { id: org._id, name: org.name, slug: org.slug, logoUrl: org.logoUrl, status: org.status, city: org.address && org.address.city },
      membershipId: current._id,
      role: current.role,
      permissions: [...permissions].sort(),
      propertyIds: current.propertyIds || [],
      tenantId: current.tenantId || null,
      staffId: current.staffId || null,
      subscription: summarizeState(state),
      featureFlags: flags,
    };
  }

  return {
    user: { id: userId, fullName: req.user.fullName, phone: req.user.phone, email: req.user.email, avatar: req.user.avatar || null },
    isSuperAdmin: Boolean(req.auth.isSuperAdmin),
    organizations: memberships
      .filter(m => orgOf.has(m.organizationId))
      .map(m => {
        const o = orgOf.get(m.organizationId);
        return { organizationId: o._id, name: o.name, city: o.address && o.address.city, role: m.role, status: m.status, membershipId: m._id, orgStatus: o.status };
      }),
    active: activeContext,
    catalog: { limits: LIMIT_KEYS, features: FEATURE_KEYS },
  };
});

const CreateOrgDto = z.object({
  name: text(120).min(2, 'Enter your PG / business name'),
  city: text(60).optional(),
  state: text(60).optional(),
  phone: phone.optional(),
  email: email.optional(),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, 'Invalid GSTIN').optional(),
});

r.post('/organizations', { auth: 'user', body: CreateOrgDto, success: 201, summary: 'Create a PG organization (starts a trial)' }, async req => {
  if (req.auth.isSuperAdmin) throw errors.forbidden('Platform admins cannot own organizations.', 'SUPER_ADMIN_ONLY');
  const result = await createOrganization(req.user, req.valid.body);
  audit(req, {
    organizationId: result.organization.id,
    action: 'organization.create',
    entityType: 'Organization',
    entityId: result.organization.id,
    summary: `Organization "${result.organization.name}" created`,
  });
  require('../../analytics/track').track('subscription_started', {
    userId: req.user._id,
    organizationId: result.organization.id,
    props: { plan: result.subscription.planCode, status: result.subscription.status },
  });
  return result;
});

module.exports = r.router;
