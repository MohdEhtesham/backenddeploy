const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');

const TenantAgreementSchema = createSchema(
  {
    agreementNumber: { type: String, required: true },
    tenantId: ref('Tenant', { required: true, index: true }),
    allocationId: ref('BedAllocation', { default: null }),
    propertyId: ref('PgProperty', { required: true }),
    bedId: ref('Bed', { default: null }),
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    monthlyRent: { type: Number, required: true, min: 0 },
    depositAmount: { type: Number, default: 0, min: 0 },
    lockInMonths: { type: Number, default: 0, min: 0, max: 60 },
    noticePeriodDays: { type: Number, default: 30, min: 0, max: 180 },
    terms: { type: String, trim: true, maxlength: 20000, default: '' },
    status: {
      type: String,
      enum: ['DRAFT', 'ACTIVE', 'ENDED', 'TERMINATED'],
      default: 'ACTIVE',
      index: true,
    },
    // In-app e-acceptance by the tenant.
    acceptedAt: { type: Date, default: null },
    acceptedByUserId: userRef({ default: null }),
    acceptedIp: { type: String, default: '' },
    documentId: ref('TenantDocument', { default: null }),
    endedAt: { type: Date, default: null },
  },
  { collection: 'pg_tenant_agreements' },
);

TenantAgreementSchema.index({ organizationId: 1, agreementNumber: 1 }, { unique: true });

module.exports =
  mongoose.models.TenantAgreement || mongoose.model('TenantAgreement', TenantAgreementSchema);
