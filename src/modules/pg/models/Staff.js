const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');

const JOB_ROLES = [
  'WARDEN',
  'MANAGER',
  'RECEPTIONIST',
  'ACCOUNTANT',
  'COOK',
  'CLEANER',
  'SECURITY_GUARD',
  'ELECTRICIAN',
  'PLUMBER',
  'OTHER',
];
const DEPARTMENTS = ['ADMIN', 'FRONT_DESK', 'ACCOUNTS', 'HOUSEKEEPING', 'KITCHEN', 'MAINTENANCE', 'SECURITY', 'OTHER'];

const StaffSchema = createSchema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, required: true, trim: true, maxlength: 15 },
    email: { type: String, trim: true, lowercase: true, default: '' },
    jobRole: { type: String, enum: JOB_ROLES, default: 'OTHER' },
    department: { type: String, enum: DEPARTMENTS, default: 'OTHER', index: true },
    propertyIds: [{ type: String }],
    salary: { type: Number, default: 0, min: 0 },
    joinedAt: { type: Date, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
    // Linked login (optional): staff with app access are also members.
    userId: userRef({ default: null }),
    membershipId: ref('OrganizationUser', { default: null }),
    address: { type: String, trim: true, maxlength: 300, default: '' },
    emergencyContact: {
      name: { type: String, trim: true, default: '' },
      phone: { type: String, trim: true, default: '' },
    },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { softDelete: true, collection: 'pg_staff' },
);

StaffSchema.index({ organizationId: 1, phone: 1 });

module.exports = mongoose.models.Staff || mongoose.model('Staff', StaffSchema);
module.exports.JOB_ROLES = JOB_ROLES;
module.exports.DEPARTMENTS = DEPARTMENTS;
