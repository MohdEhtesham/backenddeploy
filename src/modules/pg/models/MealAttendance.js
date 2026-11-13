const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');

const MEALS = ['BREAKFAST', 'LUNCH', 'DINNER'];

// Mess-enrolled tenants are expected at every meal by default; a row
// records an opt-out (made in advance by the tenant) or a served meal
// (marked by kitchen staff).
const MealAttendanceSchema = createSchema(
  {
    propertyId: ref('PgProperty', { required: true, index: true }),
    tenantId: ref('Tenant', { required: true, index: true }),
    date: { type: Date, required: true },
    dateKey: { type: String, required: true },
    meal: { type: String, enum: MEALS, required: true },
    status: { type: String, enum: ['OPTED_OUT', 'CONSUMED'], required: true },
    markedBy: userRef({ default: null }),
    markedByRole: { type: String, default: '' },
  },
  { collection: 'pg_meal_attendance' },
);

MealAttendanceSchema.index({ organizationId: 1, tenantId: 1, dateKey: 1, meal: 1 }, { unique: true });
MealAttendanceSchema.index({ organizationId: 1, propertyId: 1, dateKey: 1 });

module.exports = mongoose.models.MealAttendance || mongoose.model('MealAttendance', MealAttendanceSchema);
module.exports.MEALS = MEALS;
