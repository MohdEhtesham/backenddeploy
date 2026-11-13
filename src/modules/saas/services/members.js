const OrganizationUser = require('../models/OrganizationUser');

/** User ids of active members holding any of `roles` in an organization. */
const memberUserIds = async (organizationId, roles = ['OWNER']) => {
  const rows = await OrganizationUser.find({ organizationId, role: { $in: roles }, status: 'ACTIVE' })
    .select('userId')
    .lean();
  return rows.map(r => String(r.userId));
};

/** Active members whose property scope includes `propertyId`. */
const memberUserIdsForProperty = async (organizationId, roles, propertyId) => {
  const rows = await OrganizationUser.find({ organizationId, role: { $in: roles }, status: 'ACTIVE' })
    .select('userId propertyIds')
    .lean();
  return rows
    .filter(r => !propertyId || !r.propertyIds || r.propertyIds.length === 0 || r.propertyIds.includes(propertyId))
    .map(r => String(r.userId));
};

module.exports = { memberUserIds, memberUserIdsForProperty };
