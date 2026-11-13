const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');

const ExpenseSchema = createSchema(
  {
    propertyId: ref('PgProperty', { default: null, index: true }),
    categoryId: ref('ExpenseCategory', { required: true, index: true }),
    categoryName: { type: String, default: '' },
    categoryCode: { type: String, default: 'OTHER' },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true, index: true },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    vendor: { type: String, trim: true, maxlength: 120, default: '' },
    paymentMethod: {
      type: String,
      enum: ['CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER'],
      default: 'CASH',
    },
    reference: { type: String, trim: true, maxlength: 120, default: '' },
    receiptKey: { type: String, default: '' },
    receiptDriver: { type: String, default: '' },
    createdBy: userRef({ default: null }),
  },
  { softDelete: true, collection: 'pg_expenses' },
);

ExpenseSchema.index({ organizationId: 1, date: -1 });

module.exports = mongoose.models.Expense || mongoose.model('Expense', ExpenseSchema);
