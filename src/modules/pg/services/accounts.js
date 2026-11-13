const crypto = require('crypto');
const User = require('../../../models/User');
const OrganizationUser = require('../../saas/models/OrganizationUser');

/**
 * Find the app account for a phone number, creating a minimal one when the
 * person has never used the app (they sign in later with OTP).
 */
const findOrCreateUserByPhone = async ({ phone, fullName, email }, session = null) => {
  let user = await User.findOne({ phone }).sort({ createdAt: 1 }).session(session);
  if (user) return user;

  let candidateEmail = email ? String(email).toLowerCase() : `${phone}@aabroo.app`;
  if (await User.exists({ email: candidateEmail }).session(session)) {
    candidateEmail = `${phone}.${crypto.randomBytes(3).toString('hex')}@aabroo.app`;
  }
  user = new User({
    fullName: fullName || 'New User',
    email: candidateEmail,
    phone,
    role: 'consumer',
    seller: { plan: 'free', listingQuotaUsed: 0, listingQuotaTotal: 1, totalLeads: 0, rating: 0 },
  });
  await user.setPassword(crypto.randomBytes(24).toString('base64url'));
  await user.save({ session: session || undefined });
  return user;
};

/**
 * Ensure a membership row exists for (org, user) with the given role.
 * Returns { membership, created }.
 */
const ensureMembership = async (
  { organizationId, userId, role, status = 'ACTIVE', tenantId = null, staffId = null, propertyIds = [], displayName = '', phone = '', email = '', invitedBy = null },
  session = null,
) => {
  const existing = await OrganizationUser.findOne({ organizationId, userId }).session(session);
  if (existing) {
    // A resident linked again (e.g. returning tenant) keeps their row.
    if (role === 'TENANT' && existing.role === 'TENANT') {
      existing.tenantId = tenantId || existing.tenantId;
      existing.status = 'ACTIVE';
      await existing.save({ session: session || undefined });
    }
    return { membership: existing, created: false };
  }
  const now = new Date();
  const [membership] = await OrganizationUser.create(
    [
      {
        organizationId,
        userId,
        role,
        status,
        tenantId,
        staffId,
        propertyIds,
        displayName,
        phone,
        email,
        invitedBy,
        invitedAt: invitedBy ? now : null,
        joinedAt: status === 'ACTIVE' ? now : null,
      },
    ],
    { session: session || undefined },
  );
  return { membership, created: true };
};

module.exports = { findOrCreateUserByPhone, ensureMembership };
