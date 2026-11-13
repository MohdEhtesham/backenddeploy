const mongoose = require('mongoose');
const { createSchema, ACTIVE_ONLY } = require('../../core/schema');

// Per-organization amenity catalog (seeded with defaults on org creation),
// referenced by id from properties and rooms.
const AmenitySchema = createSchema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    icon: { type: String, trim: true, maxlength: 60, default: 'checkmark-circle-outline' },
    scope: { type: String, enum: ['PROPERTY', 'ROOM', 'BOTH'], default: 'BOTH' },
    isDefault: { type: Boolean, default: false },
  },
  { softDelete: true, collection: 'pg_amenities' },
);

AmenitySchema.index({ organizationId: 1, name: 1 }, { unique: true, partialFilterExpression: ACTIVE_ONLY });

const DEFAULT_AMENITIES = [
  { name: 'Wi-Fi', icon: 'wifi-outline', scope: 'BOTH' },
  { name: 'Air conditioning', icon: 'snow-outline', scope: 'ROOM' },
  { name: 'Attached bathroom', icon: 'water-outline', scope: 'ROOM' },
  { name: 'Geyser', icon: 'thermometer-outline', scope: 'BOTH' },
  { name: 'Power backup', icon: 'flash-outline', scope: 'PROPERTY' },
  { name: 'Housekeeping', icon: 'sparkles-outline', scope: 'PROPERTY' },
  { name: 'Laundry', icon: 'shirt-outline', scope: 'PROPERTY' },
  { name: 'Meals', icon: 'restaurant-outline', scope: 'PROPERTY' },
  { name: 'CCTV', icon: 'videocam-outline', scope: 'PROPERTY' },
  { name: '24x7 Security', icon: 'shield-checkmark-outline', scope: 'PROPERTY' },
  { name: 'Parking', icon: 'car-outline', scope: 'PROPERTY' },
  { name: 'RO water', icon: 'water-outline', scope: 'PROPERTY' },
  { name: 'Wardrobe', icon: 'file-tray-stacked-outline', scope: 'ROOM' },
  { name: 'Study table', icon: 'desktop-outline', scope: 'ROOM' },
  { name: 'Gym', icon: 'barbell-outline', scope: 'PROPERTY' },
  { name: 'Refrigerator', icon: 'cube-outline', scope: 'BOTH' },
];

module.exports = mongoose.models.Amenity || mongoose.model('Amenity', AmenitySchema);
module.exports.DEFAULT_AMENITIES = DEFAULT_AMENITIES;
