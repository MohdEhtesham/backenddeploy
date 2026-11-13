const mongoose = require('mongoose');
const { createSchema, ref, userRef } = require('../../core/schema');
const { HistorySchema, PRIORITIES } = require('./Complaint');

const STATUSES = ['CREATED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const CATEGORIES = [
  'ELECTRICITY',
  'PLUMBING',
  'AC',
  'WIFI',
  'CLEANING',
  'FURNITURE',
  'WATER',
  'PAINTING',
  'PEST_CONTROL',
  'APPLIANCE',
  'GENERAL',
  'OTHER',
];

const MaintenanceTaskSchema = createSchema(
  {
    taskNumber: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    category: { type: String, enum: CATEGORIES, default: 'GENERAL' },
    propertyId: ref('PgProperty', { required: true, index: true }),
    roomId: ref('Room', { default: null }),
    bedId: ref('Bed', { default: null }),
    complaintId: ref('Complaint', { default: null, index: true }),
    priority: { type: String, enum: PRIORITIES, default: 'MEDIUM' },
    status: { type: String, enum: STATUSES, default: 'CREATED', index: true },
    assignedToStaffId: ref('Staff', { default: null, index: true }),
    assignedAt: { type: Date, default: null },
    inProgressAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    estimatedCost: { type: Number, default: 0, min: 0 },
    actualCost: { type: Number, default: 0, min: 0 },
    createdBy: userRef({ default: null }),
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    history: { type: [HistorySchema], default: [] },
  },
  { collection: 'pg_maintenance_tasks' },
);

MaintenanceTaskSchema.index({ organizationId: 1, taskNumber: 1 }, { unique: true });

module.exports =
  mongoose.models.MaintenanceTask || mongoose.model('MaintenanceTask', MaintenanceTaskSchema);
module.exports.STATUSES = STATUSES;
module.exports.CATEGORIES = CATEGORIES;
