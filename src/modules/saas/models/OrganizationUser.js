const mongoose = require('mongoose');
const { createSchema, userRef, ref } = require('../../core/schema');
const { ROLE_KEYS } = require('../../core/permissions');

// Membership of a User in an Organization. This row — never the client —
// decides a caller's role, permissions and property scope.
const OrganizationUserSchema = createSchema(
  {
    userId: userRef({ required: true, index: true }),
    role: { type: String, enum: ROLE_KEYS, required: true },
    // Empty = access to every property of the organization.
    propertyIds: [{ type: String }],
    status: { type: String, enum: ['INVITED', 'ACTIVE', 'DISABLED'], default: 'ACTIVE', index: true },
    tenantId: ref('Tenant', { default: null }),
    staffId: ref('Staff', { default: null }),
    displayName: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    invitedBy: userRef({ default: null }),
    invitedAt: { type: Date, default: null },
    joinedAt: { type: Date, default: null },
  },
  { collection: 'saas_organization_users' },
);

OrganizationUserSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
OrganizationUserSchema.index({ organizationId: 1, role: 1, status: 1 });

module.exports =
  mongoose.models.OrganizationUser || mongoose.model('OrganizationUser', OrganizationUserSchema);
