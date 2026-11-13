const mongoose = require('mongoose');
const { createSchema } = require('../../core/schema');

// System roles have organizationId = null. The field exists so that
// organization-specific custom roles can be introduced without a migration.
const RoleSchema = createSchema(
  {
    organizationId: { type: String, default: null, index: true },
    key: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    permissions: [{ type: String }],
    isSystem: { type: Boolean, default: false },
  },
  { tenant: false, collection: 'saas_roles' },
);

RoleSchema.index({ organizationId: 1, key: 1 }, { unique: true });

module.exports = mongoose.models.Role || mongoose.model('Role', RoleSchema);
