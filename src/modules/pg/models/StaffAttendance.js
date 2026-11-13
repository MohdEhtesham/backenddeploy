const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');

const StaffAttendanceSchema = createSchema(
  {
    staffId: ref('Staff', { required: true, index: true }),
    propertyId: ref('PgProperty', { default: null }),
    date: { type: Date, required: true, index: true },
    dateKey: { type: String, required: true },
    status: { type: String, enum: ['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'HOLIDAY'], required: true },
    checkInAt: { type: Date, default: null },
    checkOutAt: { type: Date, default: null },
    markedBy: userRef({ default: null }),
    note: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { collection: 'pg_staff_attendance' },
);

StaffAttendanceSchema.index({ organizationId: 1, staffId: 1, dateKey: 1 }, { unique: true });

module.exports =
  mongoose.models.StaffAttendance || mongoose.model('StaffAttendance', StaffAttendanceSchema);
