const { createRouter } = require('../../core/router');
const { z, text, requiredText, id, listQuery } = require('../../core/validation');
const Building = require('../models/Building');
const Floor = require('../models/Floor');
const Room = require('../models/Room');
const { crud } = require('./_crud');
const { resolveLocation } = require('../services/structure');
const errors = require('../../core/errors');

const buildings = createRouter({ prefix: '/pg/buildings', tag: 'Structure' });

crud(buildings, Building, {
  entity: 'Building',
  permissions: { read: 'structure.read', create: 'structure.manage', update: 'structure.manage', delete: 'structure.manage' },
  dto: {
    list: listQuery({ propertyId: id.optional() }),
    create: z.object({ propertyId: id, name: requiredText(80), code: text(12).optional(), description: text(500).optional() }),
    update: z.object({ name: requiredText(80).optional(), code: text(12).optional(), description: text(500).optional() }),
  },
  sortable: ['createdAt', 'name'],
  defaultSort: 'name',
  searchFields: ['name', 'code'],
  auditPrefix: 'building',
  beforeCreate: async (req, data) => {
    await resolveLocation(req.ctx.orgId, { propertyId: data.propertyId });
    return data;
  },
  beforeDelete: async (req, doc) => {
    if (await Floor.exists({ organizationId: req.ctx.orgId, buildingId: doc._id })) {
      throw errors.conflict('Delete the floors in this building first.', 'BUILDING_IN_USE');
    }
  },
});

const floors = createRouter({ prefix: '/pg/floors', tag: 'Structure' });

crud(floors, Floor, {
  entity: 'Floor',
  permissions: { read: 'structure.read', create: 'structure.manage', update: 'structure.manage', delete: 'structure.manage' },
  dto: {
    list: listQuery({ propertyId: id.optional(), buildingId: id.optional() }),
    create: z.object({ propertyId: id, buildingId: id, name: requiredText(60), level: z.coerce.number().int().min(-5).max(200) }),
    update: z.object({ name: requiredText(60).optional(), level: z.coerce.number().int().min(-5).max(200).optional() }),
  },
  sortable: ['level', 'createdAt'],
  defaultSort: 'level',
  searchFields: ['name'],
  auditPrefix: 'floor',
  listFilter: (_req, q) => (q.buildingId ? { buildingId: q.buildingId } : {}),
  beforeCreate: async (req, data) => {
    await resolveLocation(req.ctx.orgId, { propertyId: data.propertyId, buildingId: data.buildingId });
    return data;
  },
  beforeDelete: async (req, doc) => {
    if (await Room.exists({ organizationId: req.ctx.orgId, floorId: doc._id })) {
      throw errors.conflict('Delete the rooms on this floor first.', 'FLOOR_IN_USE');
    }
  },
});

module.exports = { buildingsRouter: buildings.router, floorsRouter: floors.router };
