const mongoose = require('mongoose');
const { createSchema, ref, ACTIVE_ONLY } = require('../../core/schema');

const ROOM_TYPES = ['SINGLE', 'DOUBLE', 'TRIPLE', 'FOUR_SHARING', 'CUSTOM'];
const CAPACITY_BY_TYPE = { SINGLE: 1, DOUBLE: 2, TRIPLE: 3, FOUR_SHARING: 4 };

const RoomSchema = createSchema(
  {
    propertyId: ref('PgProperty', { required: true, index: true }),
    buildingId: ref('Building', { required: true, index: true }),
    floorId: ref('Floor', { required: true, index: true }),
    roomNumber: { type: String, required: true, trim: true, maxlength: 20 },
    roomType: { type: String, enum: ROOM_TYPES, required: true },
    capacity: { type: Number, required: true, min: 1, max: 20 },
    // Default monthly rent / deposit per bed (a bed may override).
    rentPerBed: { type: Number, required: true, min: 0 },
    depositPerBed: { type: Number, default: 0, min: 0 },
    amenityIds: [{ type: String }],
    attributes: {
      ac: { type: Boolean, default: false },
      attachedBathroom: { type: Boolean, default: false },
      balcony: { type: Boolean, default: false },
      furnished: { type: Boolean, default: true },
    },
    // Manual override; occupancy is derived from beds.
    status: { type: String, enum: ['ACTIVE', 'MAINTENANCE', 'BLOCKED'], default: 'ACTIVE', index: true },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { softDelete: true, collection: 'pg_rooms' },
);

RoomSchema.index(
  { organizationId: 1, propertyId: 1, roomNumber: 1 },
  { unique: true, partialFilterExpression: ACTIVE_ONLY },
);

RoomSchema.statics.ROOM_TYPES = ROOM_TYPES;
RoomSchema.statics.CAPACITY_BY_TYPE = CAPACITY_BY_TYPE;

module.exports = mongoose.models.Room || mongoose.model('Room', RoomSchema);
module.exports.ROOM_TYPES = ROOM_TYPES;
module.exports.CAPACITY_BY_TYPE = CAPACITY_BY_TYPE;
