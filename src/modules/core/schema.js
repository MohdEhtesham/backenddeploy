const mongoose = require('mongoose');
const { uuid } = require('./ids');
const tenancyPlugin = require('./plugins/tenancy');
const softDeletePlugin = require('./plugins/softDelete');

// API shape: `id` instead of `_id`, no `__v`.
const transform = (_doc, ret) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  return ret;
};

/**
 * Schema factory for every PG / SaaS collection:
 *   - UUID string `_id` (non-guessable, unlike ObjectIds)
 *   - createdAt / updatedAt
 *   - `organizationId` + tenant guard (unless tenant: false)
 *   - optional soft delete
 */
const createSchema = (definition, { tenant = true, tenantIndex = true, softDelete = false, collection, ...options } = {}) => {
  const schema = new mongoose.Schema(
    { _id: { type: String, default: uuid }, ...definition },
    { timestamps: true, collection, ...options },
  );
  schema.set('toJSON', { virtuals: false, versionKey: false, transform });
  // tenantIndex: false when the schema declares its own organizationId index.
  if (tenant) schema.plugin(tenancyPlugin, { index: tenantIndex });
  if (softDelete) schema.plugin(softDeletePlugin);
  return schema;
};

/** Plain object (lean doc or hydrated doc) → API shape. */
const publicDoc = doc => {
  if (!doc) return doc;
  if (typeof doc.toJSON === 'function') return doc.toJSON();
  const { _id, __v, ...rest } = doc;
  return _id === undefined ? rest : { id: _id, ...rest };
};

/** Reusable embedded sub-schema options (no own _id). */
const sub = definition => new mongoose.Schema(definition, { _id: false });

/** Reference to the legacy ObjectId-keyed User collection. */
const userRef = (extra = {}) => ({ type: mongoose.Schema.Types.ObjectId, ref: 'User', ...extra });

/** Reference to a UUID-keyed PG / SaaS document. */
const ref = (model, extra = {}) => ({ type: String, ref: model, ...extra });

const ACTIVE_ONLY = softDeletePlugin.ACTIVE_ONLY;

module.exports = { createSchema, publicDoc, sub, userRef, ref, transform, ACTIVE_ONLY };
