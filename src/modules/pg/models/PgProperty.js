const mongoose = require('mongoose');
const { createSchema, sub, ACTIVE_ONLY } = require('../../core/schema');

const AddressSchema = sub({
  line1: { type: String, trim: true, default: '' },
  line2: { type: String, trim: true, default: '' },
  locality: { type: String, trim: true, default: '' },
  landmark: { type: String, trim: true, default: '' },
  city: { type: String, trim: true, default: '' },
  state: { type: String, trim: true, default: '' },
  pincode: { type: String, trim: true, default: '' },
});

const ContactSchema = sub({
  name: { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  whatsapp: { type: String, trim: true, default: '' },
});

const PhotoSchema = sub({
  url: { type: String, required: true },
  publicId: { type: String, default: '' },
});

// A PG / hostel building complex owned by an organization. (The marketplace
// already owns the `Property` model name, hence PgProperty.)
const PgPropertySchema = createSchema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, trim: true, uppercase: true, maxlength: 12, default: '' },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    propertyType: {
      type: String,
      enum: ['PG', 'HOSTEL', 'CO_LIVING', 'SERVICED_APARTMENT'],
      default: 'PG',
    },
    genderType: { type: String, enum: ['MALE', 'FEMALE', 'UNISEX'], default: 'UNISEX' },
    address: { type: AddressSchema, default: () => ({}) },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    amenityIds: [{ type: String }],
    rules: [{ type: String, trim: true, maxlength: 300 }],
    photos: { type: [PhotoSchema], default: [] },
    contact: { type: ContactSchema, default: () => ({}) },
    messEnabled: { type: Boolean, default: false },
    messChargeMonthly: { type: Number, default: 0, min: 0 },
    foodType: { type: String, enum: ['VEG', 'NON_VEG', 'BOTH'], default: 'BOTH' },
    // Optional overrides of the organization billing settings.
    billingDay: { type: Number, min: 1, max: 28, default: null },
    dueDays: { type: Number, min: 0, max: 60, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  },
  { softDelete: true, collection: 'pg_properties' },
);

PgPropertySchema.index({ organizationId: 1, name: 1 }, { unique: true, partialFilterExpression: ACTIVE_ONLY });

module.exports = mongoose.models.PgProperty || mongoose.model('PgProperty', PgPropertySchema);
