const PgProperty = require('../models/PgProperty');
const Building = require('../models/Building');
const Floor = require('../models/Floor');
const Room = require('../models/Room');
const Bed = require('../models/Bed');
const Amenity = require('../models/Amenity');
const { CAPACITY_BY_TYPE } = require('../models/Room');
const errors = require('../../core/errors');

const BED_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const bedLabel = i => (i < 26 ? BED_LABELS[i] : `B${i + 1}`);

/** Capacity implied by a room type (CUSTOM → explicit capacity required). */
const capacityFor = (roomType, capacity) => {
  if (roomType === 'CUSTOM') {
    if (!capacity) throw errors.badRequest('Capacity is required for custom rooms.', 'VALIDATION_ERROR');
    return capacity;
  }
  const implied = CAPACITY_BY_TYPE[roomType];
  if (capacity && capacity !== implied) {
    throw errors.badRequest(`A ${roomType.toLowerCase().replace('_', ' ')} room has ${implied} bed(s).`, 'VALIDATION_ERROR');
  }
  return implied;
};

/** Validate that amenity ids exist in this organization. */
const assertAmenities = async (organizationId, amenityIds) => {
  const ids = [...new Set(amenityIds || [])];
  if (!ids.length) return [];
  const count = await Amenity.countDocuments({ organizationId, _id: { $in: ids } });
  if (count !== ids.length) throw errors.badRequest('One or more amenities are invalid.', 'INVALID_REFERENCE');
  return ids;
};

/** Resolve and validate the property → building → floor chain in one org. */
const resolveLocation = async (organizationId, { propertyId, buildingId, floorId }, session = null) => {
  const property = await PgProperty.findOne({ _id: propertyId, organizationId }).session(session).lean();
  if (!property) throw errors.notFound('Property');
  let building = null;
  if (buildingId) {
    building = await Building.findOne({ _id: buildingId, organizationId, propertyId }).session(session).lean();
    if (!building) throw errors.notFound('Building');
  }
  let floor = null;
  if (floorId) {
    floor = await Floor.findOne({ _id: floorId, organizationId, propertyId, ...(buildingId ? { buildingId } : {}) })
      .session(session)
      .lean();
    if (!floor) throw errors.notFound('Floor');
  }
  return { property, building, floor };
};

/** Create `count` beds for a room, continuing the label sequence. */
const createBeds = async (room, count, startIndex = 0, session = null) => {
  const docs = [];
  for (let i = 0; i < count; i += 1) {
    docs.push({
      organizationId: room.organizationId,
      propertyId: room.propertyId,
      buildingId: room.buildingId,
      floorId: room.floorId,
      roomId: room._id,
      label: bedLabel(startIndex + i),
    });
  }
  if (!docs.length) return [];
  return Bed.insertMany(docs, { session: session || undefined });
};

const EMPTY_COUNTS = () => ({ total: 0, AVAILABLE: 0, RESERVED: 0, OCCUPIED: 0, MAINTENANCE: 0, BLOCKED: 0 });

/** Bed status counts grouped by a field (roomId / propertyId / floorId). */
const bedCountsBy = async (organizationId, field, ids) => {
  const match = { organizationId, deletedAt: null };
  if (ids) match[field] = { $in: ids };
  const rows = await Bed.aggregate([
    { $match: match },
    { $group: { _id: { key: `$${field}`, status: '$status' }, n: { $sum: 1 } } },
  ]);
  const out = new Map();
  for (const r of rows) {
    const key = r._id.key;
    if (!out.has(key)) out.set(key, EMPTY_COUNTS());
    const c = out.get(key);
    c[r._id.status] = r.n;
    c.total += r.n;
  }
  return out;
};

const occupancyOf = counts => {
  const c = counts || EMPTY_COUNTS();
  return {
    totalBeds: c.total,
    occupiedBeds: c.OCCUPIED,
    availableBeds: c.AVAILABLE,
    reservedBeds: c.RESERVED,
    blockedBeds: c.BLOCKED + c.MAINTENANCE,
    occupancyPct: c.total ? Math.round((c.OCCUPIED / c.total) * 1000) / 10 : 0,
  };
};

module.exports = {
  bedLabel,
  capacityFor,
  assertAmenities,
  resolveLocation,
  createBeds,
  bedCountsBy,
  occupancyOf,
  EMPTY_COUNTS,
};
