const { createRouter } = require('../../core/router');
const { z, text, id, idParams, listQuery, dayKey } = require('../../core/validation');
const Bed = require('../models/Bed');
const Room = require('../models/Room');
const Floor = require('../models/Floor');
const Tenant = require('../models/Tenant');
const BedAllocation = require('../models/BedAllocation');
const Amenity = require('../models/Amenity');
const { BED_STATUSES } = require('../models/Bed');
const { crud } = require('./_crud');
const { loadOwned } = require('../../core/refs');
const { publicDoc } = require('../../core/schema');
const { withTransaction } = require('../../core/tx');
const { audit } = require('../../core/audit');
const D = require('../../core/dates');
const errors = require('../../core/errors');

const r = createRouter({ prefix: '/pg/beds', tag: 'Structure' });

/** Room number, floor name, effective rent and occupant for bed rows. */
const decorateBeds = async (req, items) => {
  if (!items.length) return items;
  const organizationId = req.ctx.orgId;
  const [rooms, floors, tenants] = await Promise.all([
    Room.find({ organizationId, _id: { $in: [...new Set(items.map(b => b.roomId))] } }).select('roomNumber roomType rentPerBed depositPerBed attributes').lean(),
    Floor.find({ organizationId, _id: { $in: [...new Set(items.map(b => b.floorId))] } }).select('name level').lean(),
    Tenant.find({ organizationId, _id: { $in: items.map(b => b.currentTenantId).filter(Boolean) } }).select('fullName phone status').lean(),
  ]);
  const roomOf = new Map(rooms.map(x => [x._id, x]));
  const floorOf = new Map(floors.map(x => [x._id, x]));
  const tenantOf = new Map(tenants.map(x => [x._id, x]));
  return items.map(b => {
    const room = roomOf.get(b.roomId) || {};
    const floor = floorOf.get(b.floorId) || {};
    const t = b.currentTenantId ? tenantOf.get(b.currentTenantId) : null;
    return {
      ...b,
      roomNumber: room.roomNumber || '',
      roomType: room.roomType || '',
      roomAttributes: room.attributes || {},
      floorName: floor.name || '',
      effectiveRent: b.rent ?? room.rentPerBed ?? 0,
      effectiveDeposit: b.deposit ?? room.depositPerBed ?? 0,
      tenant: t ? { id: t._id, fullName: t.fullName, status: t.status } : null,
    };
  });
};

crud(r, Bed, {
  entity: 'Bed',
  permissions: { read: 'structure.read', update: 'structure.manage', delete: 'structure.manage' },
  dto: {
    list: listQuery({
      propertyId: id.optional(),
      roomId: id.optional(),
      floorId: id.optional(),
      buildingId: id.optional(),
      status: z.enum(BED_STATUSES).optional(),
    }),
    update: z.object({
      label: z.string().trim().min(1).max(10).optional(),
      rent: z.coerce.number().min(0).max(1000000).nullable().optional(),
      deposit: z.coerce.number().min(0).max(10000000).nullable().optional(),
    }),
  },
  sortable: ['label', 'createdAt', 'status'],
  defaultSort: 'label',
  only: ['list', 'update', 'delete'],
  auditPrefix: 'bed',
  listFilter: (_req, q) => ({
    ...(q.roomId ? { roomId: q.roomId } : {}),
    ...(q.floorId ? { floorId: q.floorId } : {}),
    ...(q.buildingId ? { buildingId: q.buildingId } : {}),
    ...(q.status ? { status: q.status } : {}),
  }),
  decorate: decorateBeds,
  beforeDelete: async (req, doc) => {
    if (['OCCUPIED', 'RESERVED'].includes(doc.status)) {
      throw errors.conflict('Occupied or reserved beds cannot be removed.', 'BED_IN_USE');
    }
    await Room.updateOne({ _id: doc.roomId, organizationId: req.ctx.orgId }, { $inc: { capacity: -1 }, $set: { roomType: 'CUSTOM' } });
  },
});

r.get('/:id', { permission: 'structure.read', params: idParams, summary: 'Bed with room, occupant and history' }, async req => {
  const bed = await loadOwned(Bed, req.valid.params.id, req, { entity: 'Bed', lean: true });
  const [decorated] = await decorateBeds(req, [publicDoc(bed)]);
  const history = await BedAllocation.find({ organizationId: req.ctx.orgId, bedId: bed._id }).sort({ startDate: -1 }).limit(50).lean();
  const tenants = await Tenant.find({ organizationId: req.ctx.orgId, _id: { $in: history.map(h => h.tenantId) } }).select('fullName').lean();
  const nameOf = new Map(tenants.map(t => [t._id, t.fullName]));
  const amenityIds = (await Room.findOne({ organizationId: req.ctx.orgId, _id: bed.roomId }).select('amenityIds').lean())?.amenityIds || [];
  const amenities = amenityIds.length
    ? await Amenity.find({ organizationId: req.ctx.orgId, _id: { $in: amenityIds } }).select('name icon').lean()
    : [];
  return {
    ...decorated,
    amenities: amenities.map(publicDoc),
    history: history.map(h => ({
      id: h._id,
      tenantId: h.tenantId,
      tenantName: nameOf.get(h.tenantId) || '',
      startDate: h.startDate,
      endDate: h.endDate,
      status: h.status,
      endReason: h.endReason,
      monthlyRent: h.monthlyRent,
    })),
  };
});

const StatusDto = z.object({
  status: z.enum(['AVAILABLE', 'MAINTENANCE', 'BLOCKED', 'RESERVED']),
  note: text(300).optional(),
  reservedForTenantId: id.optional(),
  reservedUntil: dayKey.optional(),
});

// Operational status changes. OCCUPIED is only ever set / cleared by
// check-in, transfer and check-out.
r.post('/:id/status', { permission: 'bed.status.update', params: idParams, body: StatusDto, summary: 'Block / unblock / reserve / maintenance' }, async req => {
  const organizationId = req.ctx.orgId;
  const bed = await loadOwned(Bed, req.valid.params.id, req, { entity: 'Bed', lean: true });
  const b = req.valid.body;
  if (bed.status === 'OCCUPIED') throw errors.conflict('An occupied bed must be checked out first.', 'BED_OCCUPIED');
  if (bed.status === b.status && b.status !== 'RESERVED') return publicDoc(bed);

  const set = { status: b.status, statusNote: b.note || '', statusChangedAt: new Date(), reservedForTenantId: null, reservedUntil: null };
  if (b.status === 'RESERVED') {
    if (!b.reservedForTenantId) throw errors.badRequest('Choose the tenant this bed is reserved for.', 'VALIDATION_ERROR');
    const tenant = await Tenant.findOne({ _id: b.reservedForTenantId, organizationId }).select('status').lean();
    if (!tenant) throw errors.notFound('Tenant');
    set.reservedForTenantId = b.reservedForTenantId;
    set.reservedUntil = b.reservedUntil ? D.addDays(D.toDay(b.reservedUntil), 1) : D.addDays(new Date(), 7);
  }
  // Conditional on the status we just read → no race with a check-in.
  const updated = await withTransaction(session =>
    Bed.findOneAndUpdate(
      { _id: bed._id, organizationId, status: bed.status },
      { $set: set },
      { new: true, session: session || undefined },
    ).lean(),
  );
  if (!updated) throw errors.conflict('The bed changed just now. Please refresh.', 'CONCURRENT_UPDATE');
  audit(req, { action: 'bed.status', entityType: 'Bed', entityId: bed._id, changes: { status: { from: bed.status, to: b.status } }, summary: b.note || '' });
  return publicDoc(updated);
});

const amenities = createRouter({ prefix: '/pg/amenities', tag: 'Structure' });

crud(amenities, Amenity, {
  entity: 'Amenity',
  propertyField: null,
  permissions: { read: 'property.read', create: 'amenity.manage', update: 'amenity.manage', delete: 'amenity.manage' },
  dto: {
    list: listQuery({ scope: z.enum(['PROPERTY', 'ROOM', 'BOTH']).optional() }),
    create: z.object({ name: z.string().trim().min(1).max(60), icon: text(60).optional(), scope: z.enum(['PROPERTY', 'ROOM', 'BOTH']).default('BOTH') }),
    update: z.object({ name: z.string().trim().min(1).max(60).optional(), icon: text(60).optional(), scope: z.enum(['PROPERTY', 'ROOM', 'BOTH']).optional() }),
  },
  sortable: ['name', 'createdAt'],
  defaultSort: 'name',
  searchFields: ['name'],
  auditPrefix: 'amenity',
  listFilter: (_req, q) => (q.scope ? { scope: { $in: [q.scope, 'BOTH'] } } : {}),
});

module.exports = { bedsRouter: r.router, amenitiesRouter: amenities.router };
