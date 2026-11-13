const { createRouter } = require('../../core/router');
const { z, text, requiredText, phone, email, id, idParams, listQuery, url } = require('../../core/validation');
const PgProperty = require('../models/PgProperty');
const Building = require('../models/Building');
const Floor = require('../models/Floor');
const Room = require('../models/Room');
const Bed = require('../models/Bed');
const Tenant = require('../models/Tenant');
const { crud } = require('./_crud');
const { assertAmenities, bedCountsBy, occupancyOf } = require('../services/structure');
const { loadOwned } = require('../../core/refs');
const { publicDoc } = require('../../core/schema');
const errors = require('../../core/errors');

const r = createRouter({ prefix: '/pg/properties', tag: 'Properties' });

const AddressDto = z.object({
  line1: text(200).default(''),
  line2: text(200).optional(),
  locality: text(100).optional(),
  landmark: text(100).optional(),
  city: requiredText(60),
  state: requiredText(60),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
});

const base = {
  name: requiredText(120),
  code: z.string().trim().toUpperCase().max(12).optional(),
  description: text(2000).optional(),
  propertyType: z.enum(['PG', 'HOSTEL', 'CO_LIVING', 'SERVICED_APARTMENT']),
  genderType: z.enum(['MALE', 'FEMALE', 'UNISEX']),
  address: AddressDto,
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).partial().optional(),
  amenityIds: z.array(id).max(60).optional(),
  rules: z.array(text(300)).max(40).optional(),
  photos: z.array(z.object({ url, publicId: z.string().max(200).optional() })).max(20).optional(),
  contact: z
    .object({
      name: text(80).optional(),
      phone: phone.optional().or(z.literal('')),
      email: email.optional().or(z.literal('')),
      whatsapp: phone.optional().or(z.literal('')),
    })
    .optional(),
  messEnabled: z.boolean().optional(),
  messChargeMonthly: z.coerce.number().min(0).max(100000).optional(),
  foodType: z.enum(['VEG', 'NON_VEG', 'BOTH']).optional(),
  billingDay: z.coerce.number().int().min(1).max(28).nullable().optional(),
  dueDays: z.coerce.number().int().min(0).max(60).nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
};

const CreateDto = z.object(base);
const UpdateDto = z.object(base).partial();
const ListDto = listQuery({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  city: z.string().max(60).optional(),
  propertyType: z.enum(['PG', 'HOSTEL', 'CO_LIVING', 'SERVICED_APARTMENT']).optional(),
});

/** Attach live occupancy numbers to property rows. */
const withOccupancy = async (req, items) => {
  if (!items.length) return items;
  const counts = await bedCountsBy(req.ctx.orgId, 'propertyId', items.map(i => i.id));
  return items.map(i => ({ ...i, occupancy: occupancyOf(counts.get(i.id)) }));
};

crud(r, PgProperty, {
  entity: 'Property',
  propertyField: '_id',
  permissions: { read: 'property.read', create: 'property.create', update: 'property.update', delete: 'property.delete' },
  dto: { list: ListDto, create: CreateDto, update: UpdateDto },
  sortable: ['createdAt', 'name'],
  defaultSort: 'name',
  searchFields: ['name', 'code', 'address.city', 'address.locality'],
  limitKey: 'maxProperties',
  auditPrefix: 'property',
  only: ['list', 'create', 'update', 'delete'],
  listFilter: (_req, q) => ({
    ...(q.status ? { status: q.status } : {}),
    ...(q.city ? { 'address.city': new RegExp(`^${q.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } : {}),
    ...(q.propertyType ? { propertyType: q.propertyType } : {}),
  }),
  decorate: withOccupancy,
  beforeCreate: async (req, data) => ({ ...data, amenityIds: await assertAmenities(req.ctx.orgId, data.amenityIds) }),
  beforeUpdate: async (req, _doc, data) =>
    data.amenityIds ? { ...data, amenityIds: await assertAmenities(req.ctx.orgId, data.amenityIds) } : data,
  beforeDelete: async (req, doc) => {
    const occupied = await Bed.countDocuments({ organizationId: req.ctx.orgId, propertyId: doc._id, status: 'OCCUPIED' });
    if (occupied) throw errors.conflict(`${occupied} bed(s) are occupied. Check tenants out before deleting.`, 'PROPERTY_IN_USE');
    const current = await Tenant.countDocuments({ organizationId: req.ctx.orgId, 'current.propertyId': doc._id, status: { $in: ['ACTIVE', 'NOTICE'] } });
    if (current) throw errors.conflict('This property still has current tenants.', 'PROPERTY_IN_USE');
  },
});

// Detail: property + occupancy + full structure tree (buildings → floors → rooms → beds).
r.get('/:id', { permission: 'property.read', params: idParams, summary: 'Property with structure & occupancy' }, async req => {
  const organizationId = req.ctx.orgId;
  const property = await loadOwned(PgProperty, req.valid.params.id, req, { entity: 'Property', propertyField: '_id', lean: true });
  const [buildings, floors, rooms, beds] = await Promise.all([
    Building.find({ organizationId, propertyId: property._id }).sort({ name: 1 }).lean(),
    Floor.find({ organizationId, propertyId: property._id }).sort({ level: 1 }).lean(),
    Room.find({ organizationId, propertyId: property._id }).sort({ roomNumber: 1 }).lean(),
    Bed.find({ organizationId, propertyId: property._id }).sort({ label: 1 }).lean(),
  ]);
  const tenantIds = beds.map(b => b.currentTenantId).filter(Boolean);
  const tenants = tenantIds.length
    ? await Tenant.find({ organizationId, _id: { $in: tenantIds } }).select('fullName phone status').lean()
    : [];
  const tenantOf = new Map(tenants.map(t => [t._id, { id: t._id, fullName: t.fullName, status: t.status }]));

  const bedsByRoom = new Map();
  for (const b of beds) {
    const list = bedsByRoom.get(b.roomId) || [];
    list.push({ ...publicDoc(b), tenant: b.currentTenantId ? tenantOf.get(b.currentTenantId) || null : null });
    bedsByRoom.set(b.roomId, list);
  }
  const roomsByFloor = new Map();
  for (const room of rooms) {
    const roomBeds = bedsByRoom.get(room._id) || [];
    const list = roomsByFloor.get(room.floorId) || [];
    list.push({
      ...publicDoc(room),
      beds: roomBeds,
      occupiedBeds: roomBeds.filter(b => b.status === 'OCCUPIED').length,
      availableBeds: roomBeds.filter(b => b.status === 'AVAILABLE').length,
    });
    roomsByFloor.set(room.floorId, list);
  }
  const floorsByBuilding = new Map();
  for (const f of floors) {
    const list = floorsByBuilding.get(f.buildingId) || [];
    list.push({ ...publicDoc(f), rooms: roomsByFloor.get(f._id) || [] });
    floorsByBuilding.set(f.buildingId, list);
  }
  const counts = await bedCountsBy(organizationId, 'propertyId', [property._id]);
  return {
    ...publicDoc(property),
    occupancy: occupancyOf(counts.get(property._id)),
    buildings: buildings.map(b => ({ ...publicDoc(b), floors: floorsByBuilding.get(b._id) || [] })),
  };
});

module.exports = r.router;
