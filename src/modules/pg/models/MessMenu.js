const mongoose = require('mongoose');
const { createSchema, sub, ref, userRef } = require('../../core/schema');

const MealSchema = sub({
  items: [{ type: String, trim: true, maxlength: 80 }],
  time: { type: String, trim: true, maxlength: 20, default: '' },
});

// Weekly repeating menu: one row per (property, day of week).
const MessMenuSchema = createSchema(
  {
    propertyId: ref('PgProperty', { required: true, index: true }),
    dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
    breakfast: { type: MealSchema, default: () => ({ items: [], time: '08:00' }) },
    lunch: { type: MealSchema, default: () => ({ items: [], time: '13:00' }) },
    dinner: { type: MealSchema, default: () => ({ items: [], time: '20:30' }) },
    notes: { type: String, trim: true, maxlength: 300, default: '' },
    updatedBy: userRef({ default: null }),
  },
  { collection: 'pg_mess_menus' },
);

MessMenuSchema.index({ organizationId: 1, propertyId: 1, dayOfWeek: 1 }, { unique: true });

module.exports = mongoose.models.MessMenu || mongoose.model('MessMenu', MessMenuSchema);
