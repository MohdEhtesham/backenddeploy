const mongoose = require('mongoose');
const { createSchema } = require('../../core/schema');

const PermissionSchema = createSchema(
  {
    key: { type: String, required: true, trim: true },
    module: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
  },
  { tenant: false, collection: 'saas_permissions' },
);

PermissionSchema.index({ key: 1 }, { unique: true });

module.exports = mongoose.models.Permission || mongoose.model('Permission', PermissionSchema);
