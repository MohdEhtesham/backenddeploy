const mongoose = require('mongoose');
const { createSchema, sub, ref } = require('../../core/schema');

const ChargeSchema = sub({
  type: { type: String, enum: ['FOOD', 'MAINTENANCE', 'WATER', 'ELECTRICITY', 'OTHER'], required: true },
  label: { type: String, trim: true, maxlength: 60, default: '' },
  amount: { type: Number, required: true, min: 0 },
});

const DiscountSchema = sub({
  type: { type: String, enum: ['FLAT', 'PERCENT'], default: 'FLAT' },
  value: { type: Number, default: 0, min: 0 },
  label: { type: String, trim: true, maxlength: 60, default: '' },
});

// Recurring monthly rent configuration for one stay. The billing cursor
// `nextBillingDate` is the first day not yet invoiced; the invoice job
// advances it one period at a time (idempotent — see services/invoices.js).
const RentSchema = createSchema(
  {
    tenantId: ref('Tenant', { required: true, index: true }),
    allocationId: ref('BedAllocation', { default: null }),
    propertyId: ref('PgProperty', { required: true, index: true }),
    bedId: ref('Bed', { default: null }),
    monthlyRent: { type: Number, required: true, min: 0 },
    billingDay: { type: Number, required: true, min: 1, max: 28 },
    dueDays: { type: Number, default: 5, min: 0, max: 60 },
    charges: { type: [ChargeSchema], default: [] },
    discount: { type: DiscountSchema, default: () => ({}) },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    nextBillingDate: { type: Date, required: true, index: true },
    status: { type: String, enum: ['ACTIVE', 'ENDED'], default: 'ACTIVE', index: true },
  },
  { collection: 'pg_rents' },
);

RentSchema.index(
  { organizationId: 1, tenantId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_rent_per_tenant' },
);

module.exports = mongoose.models.Rent || mongoose.model('Rent', RentSchema);
