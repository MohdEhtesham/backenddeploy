const mongoose = require('mongoose');
const { createSchema, ref } = require('../../core/schema');

// Occupancy history. The two partial unique indexes are the database-level
// guarantee against double allocation: at most ONE active allocation per
// bed and per tenant, no matter how many requests race.
const BedAllocationSchema = createSchema(
  {
    propertyId: ref('PgProperty', { required: true, index: true }),
    roomId: ref('Room', { required: true }),
    bedId: ref('Bed', { required: true, index: true }),
    tenantId: ref('Tenant', { required: true, index: true }),
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    status: { type: String, enum: ['ACTIVE', 'ENDED'], default: 'ACTIVE', index: true },
    endReason: { type: String, enum: ['CHECKOUT', 'TRANSFER', 'CANCELLED', null], default: null },
    monthlyRent: { type: Number, required: true, min: 0 },
    checkInId: ref('CheckIn', { default: null }),
    checkOutId: ref('CheckOut', { default: null }),
  },
  { collection: 'pg_bed_allocations' },
);

BedAllocationSchema.index(
  { organizationId: 1, bedId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_allocation_per_bed' },
);
BedAllocationSchema.index(
  { organizationId: 1, tenantId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_allocation_per_tenant' },
);

module.exports = mongoose.models.BedAllocation || mongoose.model('BedAllocation', BedAllocationSchema);
