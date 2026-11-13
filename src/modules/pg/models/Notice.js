const mongoose = require('mongoose');
const { createSchema, sub, userRef } = require('../../core/schema');

const AudienceSchema = sub({
  type: { type: String, enum: ['ALL', 'PROPERTY', 'FLOOR', 'ROOM', 'TENANT'], required: true },
  propertyIds: [{ type: String }],
  floorIds: [{ type: String }],
  roomIds: [{ type: String }],
  tenantIds: [{ type: String }],
});

// Recipients are resolved server-side when the notice is published and
// stored, so tenants query "notices addressed to me" with one index hit.
const NoticeSchema = createSchema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    category: {
      type: String,
      enum: ['GENERAL', 'MAINTENANCE', 'RENT', 'EVENT', 'RULES', 'EMERGENCY'],
      default: 'GENERAL',
    },
    priority: { type: String, enum: ['NORMAL', 'IMPORTANT', 'URGENT'], default: 'NORMAL' },
    audience: { type: AudienceSchema, required: true },
    recipientTenantIds: [{ type: String }],
    recipientCount: { type: Number, default: 0 },
    pinned: { type: Boolean, default: false },
    publishedAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, default: null },
    createdBy: userRef({ default: null }),
  },
  { softDelete: true, collection: 'pg_notices' },
);

NoticeSchema.index({ organizationId: 1, recipientTenantIds: 1, publishedAt: -1 });

module.exports = mongoose.models.Notice || mongoose.model('Notice', NoticeSchema);
