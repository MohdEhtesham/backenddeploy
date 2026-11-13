const { flags } = require('../scope');

// Server-side tenant isolation guard.
//
// Adds an immutable, indexed `organizationId` to the schema and refuses to
// run any read / write / delete / aggregate whose filter does not pin a
// single organization. A developer who forgets the org filter gets a loud
// 500 in tests instead of silently leaking Organization B's rows to
// Organization A. Platform code that must cross organizations wraps the
// call in `unscoped(() => …)`.

const QUERY_OPS = [
  'countDocuments',
  'distinct',
  'deleteMany',
  'deleteOne',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
];

class TenantGuardError extends Error {
  constructor(model, op) {
    super(`[tenancy] Refusing unscoped ${op} on ${model}: an organizationId filter is required`);
    this.name = 'TenantGuardError';
    this.status = 500;
    this.code = 'TENANT_GUARD';
  }
}

const isPinned = orgId => typeof orgId === 'string' && orgId.length > 0;

function tenancyPlugin(schema, { index = true } = {}) {
  schema.add({
    organizationId: { type: String, required: true, index, immutable: true },
  });

  function guardQuery() {
    if (flags().unscoped) return;
    const filter = this.getFilter() || {};
    // Only an exact string equality is accepted: operators such as $in / $ne
    // could widen the scope to other organizations.
    if (!isPinned(filter.organizationId)) {
      throw new TenantGuardError(this.model.modelName, this.op);
    }
  }

  for (const op of QUERY_OPS) schema.pre(op, guardQuery);

  schema.pre('aggregate', function guardAggregate() {
    if (flags().unscoped) return;
    const first = this.pipeline()[0];
    if (!first || !first.$match || !isPinned(first.$match.organizationId)) {
      const model = typeof this.model === 'function' ? this.model() : this._model;
      throw new TenantGuardError(model ? model.modelName : 'model', 'aggregate');
    }
  });
}

module.exports = tenancyPlugin;
module.exports.TenantGuardError = TenantGuardError;
