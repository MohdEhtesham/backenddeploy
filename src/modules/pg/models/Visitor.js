const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');

const STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'EXPIRED'];

// A visitor pass. Tenants request; security approves / rejects and checks
// the visitor in and out at the gate (each entry logged in VisitorEntry).
const VisitorSchema = createSchema(
  {
    passCode: { type: String, required: true },
    tenantId: ref('Tenant', { required: true, index: true }),
    propertyId: ref('PgProperty', { required: true, index: true }),
    visitorName: { type: String, required: true, trim: true, maxlength: 100 },
    visitorPhone: { type: String, required: true, trim: true, maxlength: 15 },
    idType: {
      type: String,
      enum: ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'OTHER', null],
      default: null,
    },
    idNumberMasked: { type: String, default: '' },
    purpose: { type: String, trim: true, maxlength: 200, default: '' },
    guests: { type: Number, default: 1, min: 1, max: 20 },
    vehicleNumber: { type: String, trim: true, uppercase: true, maxlength: 20, default: '' },
    expectedAt: { type: Date, required: true },
    validUntil: { type: Date, required: true },
    status: { type: String, enum: STATUSES, default: 'REQUESTED', index: true },
    requestedByUserId: userRef({ default: null }),
    requestedByRole: { type: String, default: '' },
    decidedByUserId: userRef({ default: null }),
    decidedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 300, default: '' },
    checkedInAt: { type: Date, default: null },
    checkedOutAt: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { collection: 'pg_visitors' },
);

VisitorSchema.index({ organizationId: 1, propertyId: 1, status: 1, expectedAt: -1 });
VisitorSchema.index({ organizationId: 1, passCode: 1 });

module.exports = mongoose.models.Visitor || mongoose.model('Visitor', VisitorSchema);
module.exports.STATUSES = STATUSES;
