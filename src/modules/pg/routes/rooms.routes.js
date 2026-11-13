const { createRouter } = require('../../core/router');
const { z, text, requiredText, id, idParams, listQuery } = require('../../core/validation');
const Room = require('../models/Room');
const Bed = require('../models/Bed');
const Tenant = require('../models/Tenant');
const { ROOM_TYPES } = require('../models/Room');
const { crud } = require('./_crud');
const { resolveLocation, capacityFor, createBeds, assertAmenities } = require('../services/structure');
const { assertLimit } = require('../../saas/services/entitlements');
const { loadOwned } = require('../../core/refs');
const { assertPropertyAccess } = require('../../core/context');
const { publicDoc } = require('../../core/schema');
const { withTransaction } = require('../../core/tx');
const { audit } = require('../../core/audit');
const errors = require('../../core/errors');

const r = createRouter({ prefix: '/pg/rooms', tag: 'Structure' });

const Attributes = z
  .object({ ac: z.boolean(), attachedBathroom: z.boolean(), balcony: z.boolean(), furnished: z.boolean() })
  .partial();

const CreateDto = z.object({
  propertyId: id,
  buildingId: id,
  floorId: id,
  roomNumber: requiredText(20),
  roomType: z.enum(ROOM_TYPES),
  capacity: z.coerce.number().int().min(1).max(20).optional(),
  rentPerBed: z.coerce.number().min(0).max(1000000),
  depositPerBed: z.coerce.number().min(0).max(10000000).optional(),
  amenityIds: z.array(id).max(40).optional(),
  attributes: Attributes.optional(),
  notes: text(500).optional(),
});

const UpdateDto = z.object({
  roomNumber: requiredText(20).optional(),
  rentPerBed: z.coerce.number().min(0).max(1000000).optional(),
  depositPerBed: z.coerce.number().min(0).max(10000000).optional(),
  amenityIds: z.array(id).max(40).optional(),
  attributes: Attributes.optional(),
  status: z.enum(['ACTIVE', 'MAINTENANCE', 'BLOCKED']).optional(),
  notes: text(500).optional(),
});

const ListDto = listQuery({
  propertyId: id.optional(),
  buildingId: id.optional(),
  floorId: id.optional(),
  roomType: z.enum(ROOM_TYPES).optional(),
  status: z.enum(['ACTIVE', 'MAINTENANCE', 'BLOCKED']).optional(),
  hasVacancy: z.enum(['true', 'false']).optional(),
});

const withBedStats = async (req, items) => {
  if (!items.length) return items;
  const beds = await Bed.find({ organizationId: req.ctx.orgId, roomId: { $in: items.map(i => i.id) } })
    .select('roomId status label rent')
    .lean();
  return items.map(i => {
    const rb = beds.filter(b => b.roomId === i.id);
    return {
      ...i,
      bedCount: rb.length,
      occupiedBeds: rb.filter(b => b.status === 'OCCUPIED').length,
      availableBeds: rb.filter(b => b.status === 'AVAILABLE').length,
    };
  });
};

crud(r, Room, {
  entity: 'Room',
  permissions: { read: 'structure.read', create: 'structure.manage', update: 'structure.manage', delete: 'structure.manage' },
  dto: { list: ListDto, update: UpdateDto },
  sortable: ['roomNumber', 'createdAt', 'rentPerBed'],
  defaultSort: 'roomNumber',
  searchFields: ['roomNumber'],
  auditPrefix: 'room',
  only: ['list', 'update', 'delete'],
  listFilter: async (req, q) => {
    const f = {};
    if (q.buildingId) f.buildingId = q.buildingId;
    if (q.floorId) f.floorId = q.floorId;
    if (q.roomType) f.roomType = q.roomType;
    if (q.status) f.status = q.status;
    if (q.hasVacancy === 'true') {
      const rooms = await Bed.distinct('roomId', { organizationId: req.ctx.orgId, status: 'AVAILABLE' });
      f._id = { $in: rooms };
    }
    return f;
  },
  decorate: withBedStats,
  beforeUpdate: async (req, _doc, data) =>
    data.amenityIds ? { ...data, amenityIds: await assertAmenities(req.ctx.orgId, data.amenityIds) } : data,
  beforeDelete: async (req, doc) => {
    const occupied = await Bed.countDocuments({ organizationId: req.ctx.orgId, roomId: doc._id, status: { $in: ['OCCUPIED', 'RESERVED'] } });
    if (occupied) throw errors.conflict('This room has occupied or reserved beds.', 'ROOM_IN_USE');
    const beds = await Bed.find({ organizationId: req.ctx.orgId, roomId: doc._id });
    for (const b of beds) await b.softDelete(req.user._id);
  },
});

// Create a room together with its beds (capacity from the room type).
r.post('/', { permission: 'structure.manage', body: CreateDto, success: 201, summary: 'Create a room (beds are created automatically)' }, async req => {
  const organizationId = req.ctx.orgId;
  const body = req.valid.body;
  const capacity = capacityFor(body.roomType, body.capacity);
  await resolveLocation(organizationId, body);
  assertPropertyAccess(req, body.propertyId);
  await assertLimit(organizationId, 'maxBeds', capacity);
  const amenityIds = await assertAmenities(organizationId, body.amenityIds);

  const result = await withTransaction(async session => {
    const [room] = await Room.create(
      [{ ...body, amenityIds, capacity, organizationId }],
      { session: session || undefined },
    );
    const beds = await createBeds(room, capacity, 0, session);
    return { ...room.toJSON(), beds: beds.map(b => b.toJSON()) };
  });
  audit(req, { action: 'room.create', entityType: 'Room', entityId: result.id, summary: `Room ${result.roomNumber} with ${capacity} bed(s)` });
  return result;
});

r.get('/:id', { permission: 'structure.read', params: idParams, summary: 'Room with beds & occupants' }, async req => {
  const room = await loadOwned(Room, req.valid.params.id, req, { entity: 'Room', lean: true });
  const beds = await Bed.find({ organizationId: req.ctx.orgId, roomId: room._id }).sort({ label: 1 }).lean();
  const tenants = await Tenant.find({ organizationId: req.ctx.orgId, _id: { $in: beds.map(b => b.currentTenantId).filter(Boolean) } })
    .select('fullName phone status joiningDate monthlyRent')
    .lean();
  const tenantOf = new Map(tenants.map(t => [t._id, publicDoc(t)]));
  return {
    ...publicDoc(room),
    beds: beds.map(b => ({ ...publicDoc(b), tenant: b.currentTenantId ? tenantOf.get(b.currentTenantId) || null : null })),
  };
});

// Grow / shrink a room: add beds, or remove free ones.
r.post(
  '/:id/beds',
  { permission: 'structure.manage', params: idParams, body: z.object({ count: z.coerce.number().int().min(1).max(10) }), success: 201, summary: 'Add beds to a room' },
  async req => {
    const room = await loadOwned(Room, req.valid.params.id, req, { entity: 'Room' });
    const { count } = req.valid.body;
    if (room.capacity + count > 20) throw errors.badRequest('A room can have at most 20 beds.', 'VALIDATION_ERROR');
    await assertLimit(req.ctx.orgId, 'maxBeds', count);
    const existing = await Bed.countDocuments({ organizationId: req.ctx.orgId, roomId: room._id });
    const created = await withTransaction(async session => {
      const beds = await createBeds(room, count, existing, session);
      room.capacity = existing + count;
      if (room.roomType !== 'CUSTOM') room.roomType = 'CUSTOM';
      await room.save({ session: session || undefined });
      return beds.map(b => b.toJSON());
    });
    audit(req, { action: 'room.beds.add', entityType: 'Room', entityId: room._id, summary: `${count} bed(s) added` });
    return created;
  },
);

module.exports = r.router;
