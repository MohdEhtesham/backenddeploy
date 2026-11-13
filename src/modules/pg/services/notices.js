const Tenant = require('../models/Tenant');
const PgProperty = require('../models/PgProperty');
const Floor = require('../models/Floor');
const Room = require('../models/Room');
const errors = require('../../core/errors');
const { assertPropertyAccess } = require('../../core/context');

const assertAllOwned = async (Model, organizationId, ids, entity) => {
  const unique = [...new Set(ids || [])];
  if (!unique.length) throw errors.badRequest(`Select at least one ${entity.toLowerCase()}.`, 'VALIDATION_ERROR');
  const rows = await Model.find({ organizationId, _id: { $in: unique } }).select('_id propertyId').lean();
  if (rows.length !== unique.length) throw errors.notFound(entity);
  return rows;
};

/**
 * Resolve a notice audience to current tenants (ACTIVE / NOTICE) of this
 * organization, honouring the publisher's property scope. Every id in the
 * audience is re-validated against the organization.
 */
const resolveAudience = async (req, audience) => {
  const organizationId = req.ctx.orgId;
  const scope = req.ctx.propertyIds;
  const filter = { organizationId, status: { $in: ['ACTIVE', 'NOTICE'] } };

  switch (audience.type) {
    case 'ALL':
      if (scope) filter['current.propertyId'] = { $in: scope };
      break;
    case 'PROPERTY': {
      const rows = await assertAllOwned(PgProperty, organizationId, audience.propertyIds, 'Property');
      rows.forEach(r => assertPropertyAccess(req, r._id));
      filter['current.propertyId'] = { $in: rows.map(r => r._id) };
      break;
    }
    case 'FLOOR': {
      const rows = await assertAllOwned(Floor, organizationId, audience.floorIds, 'Floor');
      rows.forEach(r => assertPropertyAccess(req, r.propertyId));
      filter['current.floorId'] = { $in: rows.map(r => r._id) };
      break;
    }
    case 'ROOM': {
      const rows = await assertAllOwned(Room, organizationId, audience.roomIds, 'Room');
      rows.forEach(r => assertPropertyAccess(req, r.propertyId));
      filter['current.roomId'] = { $in: rows.map(r => r._id) };
      break;
    }
    case 'TENANT': {
      const ids = [...new Set(audience.tenantIds || [])];
      if (!ids.length) throw errors.badRequest('Select at least one tenant.', 'VALIDATION_ERROR');
      const rows = await Tenant.find({ organizationId, _id: { $in: ids } }).select('_id current').lean();
      if (rows.length !== ids.length) throw errors.notFound('Tenant');
      rows.forEach(r => r.current && r.current.propertyId && assertPropertyAccess(req, r.current.propertyId));
      delete filter.status;
      filter._id = { $in: ids };
      break;
    }
    default:
      throw errors.badRequest('Unknown audience type.', 'VALIDATION_ERROR');
  }

  return Tenant.find(filter).select('_id userId').lean();
};

module.exports = { resolveAudience };
