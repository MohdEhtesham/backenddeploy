const { flags } = require('../scope');

// Soft delete: rows get `deletedAt` instead of disappearing, and every query
// hides them unless the filter mentions `deletedAt` explicitly or the call
// runs inside `withDeleted(() => …)`.
//
// `deletedAt` defaults to an explicit null so unique indexes can use the
// portable partial filter `{ deletedAt: { $type: 'null' } }` (see
// ACTIVE_ONLY) — uniqueness then only applies to live rows.

const QUERY_OPS = [
  'countDocuments',
  'distinct',
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'updateOne',
  'updateMany',
  'replaceOne',
];

function softDeletePlugin(schema) {
  schema.add({
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: String, default: null },
  });

  function hideDeleted() {
    if (flags().withDeleted) return;
    const filter = this.getFilter() || {};
    if (Object.prototype.hasOwnProperty.call(filter, 'deletedAt')) return;
    this.where({ deletedAt: null });
  }
  for (const op of QUERY_OPS) schema.pre(op, hideDeleted);

  schema.pre('aggregate', function hideDeletedAggregate() {
    if (flags().withDeleted) return;
    const pipeline = this.pipeline();
    const first = pipeline[0];
    if (first && first.$match) {
      if (!Object.prototype.hasOwnProperty.call(first.$match, 'deletedAt')) first.$match.deletedAt = null;
    } else {
      pipeline.unshift({ $match: { deletedAt: null } });
    }
  });

  schema.methods.softDelete = function softDelete(byUserId, session) {
    this.deletedAt = new Date();
    this.deletedBy = byUserId ? String(byUserId) : null;
    return this.save({ session: session || undefined });
  };
}

softDeletePlugin.ACTIVE_ONLY = { deletedAt: { $type: 'null' } };

module.exports = softDeletePlugin;
