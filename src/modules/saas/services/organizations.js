const Organization = require('../models/Organization');
const OrganizationUser = require('../models/OrganizationUser');
const Subscription = require('../models/Subscription');
const Amenity = require('../../pg/models/Amenity');
const ExpenseCategory = require('../../pg/models/ExpenseCategory');
const { DEFAULT_AMENITIES } = require('../../pg/models/Amenity');
const { DEFAULT_EXPENSE_CATEGORIES } = require('../../pg/models/ExpenseCategory');
const { createInitialSubscription } = require('./subscriptions');
const { getSettings } = require('./settings');
const { withTransaction } = require('../../core/tx');
const { unscoped } = require('../../core/scope');
const errors = require('../../core/errors');

const slugify = name =>
  String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60) || 'pg';

const uniqueSlug = async (name, session) => {
  const base = slugify(name);
  for (let i = 0; i < 20; i += 1) {
    const candidate = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (!(await Organization.exists({ slug: candidate }).session(session))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
};

/**
 * Self-serve onboarding: create an organization owned by `user`, with an
 * OWNER membership, the initial subscription (trial for a first
 * organization, free plan afterwards — no infinite trials), and default
 * amenity / expense catalogs.
 */
const createOrganization = async (user, dto) => {
  const settings = await getSettings();
  const owned = await unscoped(() =>
    OrganizationUser.countDocuments({ userId: user._id, role: 'OWNER', status: { $in: ['ACTIVE', 'INVITED'] } }),
  );
  if (owned >= settings.maxOrganizationsPerOwner) {
    throw errors.conflict(
      `You can own up to ${settings.maxOrganizationsPerOwner} organizations. Contact support for more.`,
      'ORG_LIMIT_REACHED',
    );
  }
  // One free trial per owner account.
  const previousOrgIds = (
    await unscoped(() => OrganizationUser.find({ userId: user._id, role: 'OWNER' }).select('organizationId').lean())
  ).map(m => m.organizationId);
  const hadTrial = previousOrgIds.length
    ? await unscoped(() => Subscription.exists({ organizationId: { $in: previousOrgIds }, 'history.event': 'trial_started' }))
    : false;

  return withTransaction(async session => {
    const [org] = await Organization.create(
      [
        {
          name: dto.name,
          slug: await uniqueSlug(dto.name, session),
          ownerUserId: user._id,
          phone: dto.phone || user.phone || '',
          email: dto.email || (/@aabroo\.app$/.test(user.email) ? '' : user.email) || '',
          gstin: dto.gstin || '',
          address: { city: dto.city || '', state: dto.state || '' },
        },
      ],
      { session: session || undefined },
    );
    const organizationId = org._id;
    await OrganizationUser.create(
      [
        {
          organizationId,
          userId: user._id,
          role: 'OWNER',
          status: 'ACTIVE',
          displayName: user.fullName,
          phone: user.phone,
          email: user.email,
          joinedAt: new Date(),
        },
      ],
      { session: session || undefined },
    );
    const subscription = await createInitialSubscription(organizationId, { trial: !hadTrial }, session);
    await Amenity.insertMany(
      DEFAULT_AMENITIES.map(a => ({ ...a, organizationId, isDefault: true })),
      { session: session || undefined },
    );
    await ExpenseCategory.insertMany(
      DEFAULT_EXPENSE_CATEGORIES.map(c => ({ ...c, organizationId, isSystem: true })),
      { session: session || undefined },
    );
    return { organization: org.toJSON(), subscription: subscription.toJSON() };
  });
};

module.exports = { createOrganization, slugify };
