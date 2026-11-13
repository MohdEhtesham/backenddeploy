const mongoose = require('mongoose');
const { createSchema, ref, ACTIVE_ONLY } = require('../../core/schema');

const FloorSchema = createSchema(
  {
    propertyId: ref('PgProperty', { required: true, index: true }),
    buildingId: ref('Building', { required: true, index: true }),
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // 0 = ground, negative = basement.
    level: { type: Number, required: true, min: -5, max: 200 },
  },
  { softDelete: true, collection: 'pg_floors' },
);

FloorSchema.index(
  { organizationId: 1, buildingId: 1, level: 1 },
  { unique: true, partialFilterExpression: ACTIVE_ONLY },
);

module.exports = mongoose.models.Floor || mongoose.model('Floor', FloorSchema);
