const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');

const CheckInSchema = createSchema(
  {
    checkInNumber: { type: String, required: true },
    tenantId: ref('Tenant', { required: true, index: true }),
    propertyId: ref('PgProperty', { required: true, index: true }),
    roomId: ref('Room', { required: true }),
    bedId: ref('Bed', { required: true }),
    allocationId: ref('BedAllocation', { required: true }),
    agreementId: ref('TenantAgreement', { default: null }),
    rentId: ref('Rent', { required: true }),
    checkInDate: { type: Date, required: true, index: true },
    monthlyRent: { type: Number, required: true },
    depositAmount: { type: Number, default: 0 },
    invoiceIds: [{ type: String }],
    kycStatusAtCheckIn: { type: String, default: 'PENDING' },
    performedBy: userRef({ required: true }),
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { collection: 'pg_checkins' },
);

CheckInSchema.index({ organizationId: 1, checkInNumber: 1 }, { unique: true });

module.exports = mongoose.models.CheckIn || mongoose.model('CheckIn', CheckInSchema);
