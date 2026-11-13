const mongoose = require('mongoose');
const { createSchema, ref, ACTIVE_ONLY } = require('../../core/schema');

const BED_STATUSES = ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'MAINTENANCE', 'BLOCKED'];

// Status changes to/from OCCUPIED happen only through the allocation
// service's atomic conditional updates (see services/allocation.js).
const BedSchema = createSchema(
  {
    propertyId: ref('PgProperty', { required: true, index: true }),
    buildingId: ref('Building', { required: true }),
    floorId: ref('Floor', { required: true }),
    roomId: ref('Room', { required: true, index: true }),
    label: { type: String, required: true, trim: true, maxlength: 10 },
    status: { type: String, enum: BED_STATUSES, default: 'AVAILABLE', index: true },
    // null → room.rentPerBed.
    rent: { type: Number, min: 0, default: null },
    deposit: { type: Number, min: 0, default: null },
    currentTenantId: ref('Tenant', { default: null }),
    currentAllocationId: ref('BedAllocation', { default: null }),
    reservedForTenantId: ref('Tenant', { default: null }),
    reservedUntil: { type: Date, default: null },
    statusNote: { type: String, trim: true, maxlength: 300, default: '' },
    statusChangedAt: { type: Date, default: Date.now },
  },
  { softDelete: true, collection: 'pg_beds' },
);

BedSchema.index({ organizationId: 1, roomId: 1, label: 1 }, { unique: true, partialFilterExpression: ACTIVE_ONLY });
BedSchema.index({ organizationId: 1, propertyId: 1, status: 1 });

module.exports = mongoose.models.Bed || mongoose.model('Bed', BedSchema);
module.exports.BED_STATUSES = BED_STATUSES;
