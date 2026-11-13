const mongoose = require('mongoose');

// Shared by both products. Property-marketplace rows keep module='property'
// (the default, so pre-existing documents are unaffected); PG rows carry
// module='pg' + organizationId and are served from /api/pg/notifications.
const PG_TYPES = [
  'rent_reminder',
  'invoice',
  'payment_confirmation',
  'complaint_update',
  'maintenance_update',
  'task_assigned',
  'visitor_update',
  'notice',
  'document_update',
  'checkin',
  'checkout',
  'subscription',
  'team',
];

const NotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['inquiry_update', 'visit_reminder', 'new_property', 'price_drop', 'message', 'system', ...PG_TYPES],
      required: true,
    },
    title: String,
    body: String,
    read: { type: Boolean, default: false, index: true },
    actionId: String,
    imageUrl: String,
    module: { type: String, enum: ['property', 'pg'], default: 'property', index: true },
    organizationId: { type: String, default: null, index: true },
    // Deep-link payload, e.g. { route: 'invoice', id: '…' }.
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

NotificationSchema.index({ userId: 1, module: 1, createdAt: -1 });

NotificationSchema.methods.toPublic = function () {
  const obj = this.toObject();
  obj.id = String(obj._id);
  delete obj._id;
  delete obj.__v;
  obj.createdAt = obj.createdAt;
  return obj;
};

module.exports = mongoose.model('Notification', NotificationSchema);
