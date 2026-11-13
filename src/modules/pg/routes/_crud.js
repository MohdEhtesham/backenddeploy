const { idParams } = require('../../core/validation');
const { listOptions, paginate } = require('../../core/query');
const { loadOwned } = require('../../core/refs');
const { publicDoc } = require('../../core/schema');
const { propertyScope } = require('../../core/context');
const { assertLimit } = require('../../saas/services/entitlements');
const { audit, diff } = require('../../core/audit');
const errors = require('../../core/errors');

/**
 * Register list / get / create / update / delete for a simple
 * organization-owned resource on a createRouter() instance.
 *
 * Every query is pinned to req.ctx.orgId (and the caller's property scope);
 * create strips nothing the DTO didn't allow and stamps organizationId
 * server-side.
 */
const crud = (r, Model, opts) => {
  const {
    entity,
    permissions,
    dto,
    propertyField = 'propertyId',
    sortable = ['createdAt'],
    defaultSort = '-createdAt',
    searchFields = [],
    listFilter = () => ({}),
    beforeCreate = async (_req, data) => data,
    afterCreate = async () => {},
    beforeUpdate = async (_req, _doc, data) => data,
    beforeDelete = async () => {},
    decorate = async (_req, docs) => docs,
    limitKey,
    feature,
    auditPrefix,
    only = ['list', 'get', 'create', 'update', 'delete'],
  } = opts;

  const scopeFilter = (req, requested) => (propertyField ? propertyScope(req, propertyField, requested) : {});

  if (only.includes('list')) {
    r.get(
      '/',
      { permission: permissions.read, query: dto.list, feature, summary: `List ${entity.toLowerCase()}s` },
      async req => {
        const q = req.valid.query || {};
        const filter = {
          organizationId: req.ctx.orgId,
          ...scopeFilter(req, propertyField ? q[propertyField] : undefined),
          ...(await listFilter(req, q)),
        };
        const page = await paginate(Model, filter, listOptions(q, { sortable, defaultSort, searchFields }));
        page.items = await decorate(req, page.items);
        return page;
      },
    );
  }

  if (only.includes('get')) {
    r.get('/:id', { permission: permissions.read, params: idParams, feature, summary: `Get a ${entity.toLowerCase()}` }, async req => {
      const doc = await loadOwned(Model, req.valid.params.id, req, { entity, propertyField, lean: true });
      const [item] = await decorate(req, [publicDoc(doc)]);
      return item;
    });
  }

  if (only.includes('create')) {
    r.post(
      '/',
      { permission: permissions.create, body: dto.create, feature, success: 201, summary: `Create a ${entity.toLowerCase()}` },
      async req => {
        if (limitKey) await assertLimit(req.ctx.orgId, limitKey, 1);
        const data = await beforeCreate(req, { ...req.valid.body });
        if (propertyField && data[propertyField]) propertyScope(req, propertyField, data[propertyField]);
        const doc = await Model.create({ ...data, organizationId: req.ctx.orgId });
        await afterCreate(req, doc);
        if (auditPrefix) {
          audit(req, { action: `${auditPrefix}.create`, entityType: Model.modelName, entityId: doc._id, summary: `${entity} created` });
        }
        return doc.toJSON();
      },
    );
  }

  if (only.includes('update')) {
    r.put(
      '/:id',
      { permission: permissions.update, params: idParams, body: dto.update, feature, summary: `Update a ${entity.toLowerCase()}` },
      async req => {
        const doc = await loadOwned(Model, req.valid.params.id, req, { entity, propertyField });
        const before = doc.toJSON();
        const data = await beforeUpdate(req, doc, { ...req.valid.body });
        if (propertyField && data[propertyField] && data[propertyField] !== doc[propertyField]) {
          throw errors.badRequest(`A ${entity.toLowerCase()} cannot be moved to another property.`, 'IMMUTABLE_FIELD');
        }
        doc.set(data);
        await doc.save();
        const after = doc.toJSON();
        if (auditPrefix) {
          audit(req, {
            action: `${auditPrefix}.update`,
            entityType: Model.modelName,
            entityId: doc._id,
            changes: diff(before, after, Object.keys(data)),
          });
        }
        return after;
      },
    );
  }

  if (only.includes('delete')) {
    r.delete('/:id', { permission: permissions.delete, params: idParams, feature, summary: `Delete a ${entity.toLowerCase()}` }, async req => {
      const doc = await loadOwned(Model, req.valid.params.id, req, { entity, propertyField });
      await beforeDelete(req, doc);
      if (typeof doc.softDelete === 'function') await doc.softDelete(req.user._id);
      else await Model.deleteOne({ _id: doc._id, organizationId: req.ctx.orgId });
      if (auditPrefix) {
        audit(req, { action: `${auditPrefix}.delete`, entityType: Model.modelName, entityId: doc._id, summary: `${entity} deleted` });
      }
      return { id: doc._id, deleted: true };
    });
  }
};

module.exports = { crud };
