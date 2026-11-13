const mongoose = require('mongoose');
const { createSchema, userRef } = require('./schema');

// Append-only audit trail. organizationId is null for platform actions,
// so the model is not tenant-guarded; org-level readers always filter by
// their own organizationId explicitly.
const AuditLogSchema = createSchema(
  {
    organizationId: { type: String, default: null, index: true },
    actorUserId: userRef({ default: null }),
    actorName: { type: String, default: '' },
    actorRole: { type: String, default: '' },
    action: { type: String, required: true, index: true },
    entityType: { type: String, default: '' },
    entityId: { type: String, default: '' },
    summary: { type: String, default: '' },
    changes: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    requestId: { type: String, default: '' },
  },
  { tenant: false, collection: 'audit_logs', timestamps: { createdAt: true, updatedAt: false } },
);

AuditLogSchema.index({ organizationId: 1, createdAt: -1 });
AuditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
