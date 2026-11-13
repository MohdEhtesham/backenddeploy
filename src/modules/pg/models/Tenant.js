const mongoose = require('mongoose');
const { createSchema, sub, ref, userRef } = require('../../core/schema');

const TENANT_STATUSES = ['PROSPECT', 'ACTIVE', 'NOTICE', 'CHECKED_OUT'];
const CURRENT_STATUSES = ['PROSPECT', 'ACTIVE', 'NOTICE'];

const EmergencyContactSchema = sub({
  name: { type: String, trim: true, required: true, maxlength: 80 },
  relation: { type: String, trim: true, default: '', maxlength: 40 },
  phone: { type: String, trim: true, required: true, maxlength: 15 },
});

const AddressSchema = sub({
  line1: { type: String, trim: true, default: '' },
  city: { type: String, trim: true, default: '' },
  state: { type: String, trim: true, default: '' },
  pincode: { type: String, trim: true, default: '' },
});

const CurrentStaySchema = sub({
  propertyId: ref('PgProperty', { default: null }),
  buildingId: ref('Building', { default: null }),
  floorId: ref('Floor', { default: null }),
  roomId: ref('Room', { default: null }),
  bedId: ref('Bed', { default: null }),
  allocationId: ref('BedAllocation', { default: null }),
  agreementId: ref('TenantAgreement', { default: null }),
  rentId: ref('Rent', { default: null }),
});

const TenantSchema = createSchema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, required: true, trim: true, maxlength: 15 },
    email: { type: String, trim: true, lowercase: true, default: '' },
    photoKey: { type: String, default: '' },
    dob: { type: Date, default: null },
    gender: { type: String, enum: ['MALE', 'FEMALE', 'OTHER', null], default: null },
    address: { type: AddressSchema, default: () => ({}) },
    occupation: { type: String, trim: true, default: '', maxlength: 80 },
    organizationName: { type: String, trim: true, default: '', maxlength: 120 },
    emergencyContacts: { type: [EmergencyContactSchema], default: [] },
    kycStatus: { type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED'], default: 'PENDING', index: true },
    status: { type: String, enum: TENANT_STATUSES, default: 'PROSPECT', index: true },
    // true while PROSPECT / ACTIVE / NOTICE — drives the unique phone index.
    isCurrent: { type: Boolean, default: true },
    userId: userRef({ default: null, index: true }),
    joiningDate: { type: Date, default: null },
    current: { type: CurrentStaySchema, default: () => ({}) },
    monthlyRent: { type: Number, default: 0, min: 0 },
    depositAmount: { type: Number, default: 0, min: 0 },
    depositCollected: { type: Number, default: 0 },
    depositAdjusted: { type: Number, default: 0 },
    depositRefunded: { type: Number, default: 0 },
    // Advance / overpayment available for future invoices.
    creditBalance: { type: Number, default: 0 },
    noticePeriodDays: { type: Number, default: 30, min: 0, max: 180 },
    noticeGivenAt: { type: Date, default: null },
    expectedCheckoutDate: { type: Date, default: null },
    checkedOutAt: { type: Date, default: null },
    foodPreference: {
      type: String,
      enum: ['VEG', 'NON_VEG', 'EGGETARIAN', 'VEGAN', 'JAIN', null],
      default: null,
    },
    messOptIn: { type: Boolean, default: false },
    source: { type: String, enum: ['WALK_IN', 'REFERRAL', 'ONLINE', 'BROKER', 'OTHER'], default: 'WALK_IN' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
  },
  { softDelete: true, collection: 'pg_tenants', optimisticConcurrency: true },
);

TenantSchema.pre('save', function syncIsCurrent() {
  this.isCurrent = !this.deletedAt && CURRENT_STATUSES.includes(this.status);
});

TenantSchema.index(
  { organizationId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true }, name: 'unique_current_tenant_phone' },
);
TenantSchema.index({ organizationId: 1, 'current.propertyId': 1, status: 1 });
TenantSchema.index({ organizationId: 1, fullName: 1 });

module.exports = mongoose.models.Tenant || mongoose.model('Tenant', TenantSchema);
module.exports.TENANT_STATUSES = TENANT_STATUSES;
module.exports.CURRENT_STATUSES = CURRENT_STATUSES;
