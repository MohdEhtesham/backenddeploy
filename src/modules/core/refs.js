const errors = require('./errors');
const { assertPropertyAccess } = require('./context');

/**
 * Load a document that must belong to the caller's organization (and,
 * for property-bound records, to a property the caller may access).
 * Anything else is reported as 404 — we never confirm that another
 * organization's id exists.
 */
const loadOwned = async (Model, id, req, { entity = Model.modelName, session = null, select, propertyField = 'propertyId', lean = false } = {}) => {
  if (!id) throw errors.notFound(entity);
  let q = Model.findOne({ _id: String(id), organizationId: req.ctx.orgId });
  if (select) q = q.select(select);
  if (session) q = q.session(session);
  if (lean) q = q.lean();
  const doc = await q;
  if (!doc) throw errors.notFound(entity);
  const pid = propertyField ? readPath(doc, propertyField) : null;
  if (pid) assertPropertyAccess(req, pid);
  return doc;
};

const readPath = (doc, path) =>
  path.split('.').reduce((obj, key) => (obj === null || obj === undefined ? obj : obj[key]), doc);

/** Same as loadOwned but for an explicit organization id (jobs, webhooks). */
const loadInOrg = async (Model, id, organizationId, { entity = Model.modelName, session = null, lean = false } = {}) => {
  let q = Model.findOne({ _id: String(id), organizationId });
  if (session) q = q.session(session);
  if (lean) q = q.lean();
  const doc = await q;
  if (!doc) throw errors.notFound(entity);
  return doc;
};

module.exports = { loadOwned, loadInOrg };
