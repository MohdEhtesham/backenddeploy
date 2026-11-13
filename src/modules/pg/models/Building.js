const mongoose = require('mongoose');
const { createSchema, ref, ACTIVE_ONLY } = require('../../core/schema');

const BuildingSchema = createSchema(
  {
    propertyId: ref('PgProperty', { required: true, index: true }),
    name: { type: String, required: true, trim: true, maxlength: 80 },
    code: { type: String, trim: true, uppercase: true, maxlength: 12, default: '' },
    description: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { softDelete: true, collection: 'pg_buildings' },
);

BuildingSchema.index(
  { organizationId: 1, propertyId: 1, name: 1 },
  { unique: true, partialFilterExpression: ACTIVE_ONLY },
);

module.exports = mongoose.models.Building || mongoose.model('Building', BuildingSchema);
