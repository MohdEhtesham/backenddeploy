const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');

// Gate log: one row per physical entry, closed on exit.
const VisitorEntrySchema = createSchema(
  {
    visitorId: ref('Visitor', { required: true, index: true }),
    propertyId: ref('PgProperty', { required: true, index: true }),
    tenantId: ref('Tenant', { required: true }),
    entryAt: { type: Date, required: true, index: true },
    exitAt: { type: Date, default: null },
    entryGuardUserId: userRef({ default: null }),
    exitGuardUserId: userRef({ default: null }),
    notes: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { collection: 'pg_visitor_entries' },
);

module.exports = mongoose.models.VisitorEntry || mongoose.model('VisitorEntry', VisitorEntrySchema);
