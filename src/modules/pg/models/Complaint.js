const mongoose = require('mongoose');
const { createSchema, sub, ref, userRef } = require('../../core/schema');

const CATEGORIES = ['ELECTRICITY', 'PLUMBING', 'AC', 'WIFI', 'CLEANING', 'FURNITURE', 'WATER', 'OTHER'];
const STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

const HistorySchema = sub({
  status: { type: String, required: true },
  at: { type: Date, default: Date.now },
  byUserId: userRef({ default: null }),
  byName: { type: String, default: '' },
  note: { type: String, trim: true, maxlength: 1000, default: '' },
});

const ImageSchema = sub({
  key: { type: String, required: true },
  mimeType: { type: String, default: 'image/jpeg' },
  storageDriver: { type: String, required: true },
});

const ComplaintSchema = createSchema(
  {
    complaintNumber: { type: String, required: true },
    tenantId: ref('Tenant', { default: null, index: true }),
    propertyId: ref('PgProperty', { required: true, index: true }),
    roomId: ref('Room', { default: null }),
    bedId: ref('Bed', { default: null }),
    category: { type: String, enum: CATEGORIES, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    priority: { type: String, enum: PRIORITIES, default: 'MEDIUM', index: true },
    status: { type: String, enum: STATUSES, default: 'OPEN', index: true },
    images: { type: [ImageSchema], default: [] },
    assignedToStaffId: ref('Staff', { default: null, index: true }),
    assignedAt: { type: Date, default: null },
    inProgressAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    resolutionNote: { type: String, trim: true, maxlength: 1000, default: '' },
    raisedByUserId: userRef({ default: null }),
    raisedByRole: { type: String, default: '' },
    rating: { type: Number, min: 1, max: 5, default: null },
    feedback: { type: String, trim: true, maxlength: 1000, default: '' },
    maintenanceTaskId: ref('MaintenanceTask', { default: null }),
    history: { type: [HistorySchema], default: [] },
  },
  { collection: 'pg_complaints' },
);

ComplaintSchema.index({ organizationId: 1, complaintNumber: 1 }, { unique: true });
ComplaintSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.models.Complaint || mongoose.model('Complaint', ComplaintSchema);
module.exports.CATEGORIES = CATEGORIES;
module.exports.STATUSES = STATUSES;
module.exports.PRIORITIES = PRIORITIES;
module.exports.HistorySchema = HistorySchema;
