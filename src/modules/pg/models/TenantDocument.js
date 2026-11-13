const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');

// KYC & agreement files. Stored privately (see modules/storage); clients
// only ever receive short-lived signed URLs. Full ID numbers are never
// stored — only a masked form for reference.
const TenantDocumentSchema = createSchema(
  {
    tenantId: ref('Tenant', { required: true, index: true }),
    type: {
      type: String,
      enum: ['ID_PROOF', 'ADDRESS_PROOF', 'AGREEMENT', 'PHOTO', 'OTHER'],
      required: true,
    },
    subType: {
      type: String,
      enum: ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'OTHER', null],
      default: null,
    },
    docNumberMasked: { type: String, default: '' },
    fileKey: { type: String, required: true },
    fileName: { type: String, default: '' },
    mimeType: { type: String, required: true },
    size: { type: Number, default: 0 },
    storageDriver: { type: String, required: true },
    status: { type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED'], default: 'PENDING', index: true },
    uploadedBy: userRef({ default: null }),
    uploadedByRole: { type: String, default: '' },
    verifiedBy: userRef({ default: null }),
    verifiedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 300, default: '' },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { softDelete: true, collection: 'pg_tenant_documents' },
);

module.exports = mongoose.models.TenantDocument || mongoose.model('TenantDocument', TenantDocumentSchema);
