const mongoose = require('mongoose');
const { createSchema, ACTIVE_ONLY } = require('../../core/schema');

const ExpenseCategorySchema = createSchema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    code: { type: String, trim: true, uppercase: true, maxlength: 30, default: 'OTHER' },
    icon: { type: String, trim: true, default: 'wallet-outline' },
    isSystem: { type: Boolean, default: false },
  },
  { softDelete: true, collection: 'pg_expense_categories' },
);

ExpenseCategorySchema.index({ organizationId: 1, name: 1 }, { unique: true, partialFilterExpression: ACTIVE_ONLY });

const DEFAULT_EXPENSE_CATEGORIES = [
  { name: 'Electricity', code: 'ELECTRICITY', icon: 'flash-outline' },
  { name: 'Water', code: 'WATER', icon: 'water-outline' },
  { name: 'Salary', code: 'SALARY', icon: 'people-outline' },
  { name: 'Maintenance', code: 'MAINTENANCE', icon: 'construct-outline' },
  { name: 'Food', code: 'FOOD', icon: 'restaurant-outline' },
  { name: 'Internet', code: 'INTERNET', icon: 'wifi-outline' },
  { name: 'Cleaning', code: 'CLEANING', icon: 'sparkles-outline' },
  { name: 'Supplies', code: 'SUPPLIES', icon: 'cart-outline' },
  { name: 'Other', code: 'OTHER', icon: 'ellipsis-horizontal-circle-outline' },
];

module.exports =
  mongoose.models.ExpenseCategory || mongoose.model('ExpenseCategory', ExpenseCategorySchema);
module.exports.DEFAULT_EXPENSE_CATEGORIES = DEFAULT_EXPENSE_CATEGORIES;
