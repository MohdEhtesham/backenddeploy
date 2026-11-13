const { createRouter } = require('../../core/router');
const { z, text, requiredText, id, idParams, listQuery, dayKey, dateRange } = require('../../core/validation');
const Complaint = require('../models/Complaint');
const MaintenanceTask = require('../models/MaintenanceTask');
const Staff = require('../models/Staff');
const Tenant = require('../models/Tenant');
const Room = require('../models/Room');
const PgProperty = require('../models/PgProperty');
const { CATEGORIES: COMPLAINT_CATEGORIES, STATUSES: COMPLAINT_STATUSES, PRIORITIES } = require('../models/Complaint');
const { CATEGORIES: TASK_CATEGORIES, STATUSES: TASK_STATUSES } = require('../models/MaintenanceTask');
const { COMPLAINT_FLOW, MAINTENANCE_FLOW, transition } = require('../services/workflow');
const { uploadSingle, storeUpload, signedUrl } = require('../../storage');
const { memberUserIdsForProperty } = require('../../saas/services/members');
const { listOptions, paginate } = require('../../core/query');
const { loadOwned } = require('../../core/refs');
const { propertyScope, assertPropertyAccess } = require('../../core/context');
const { publicDoc } = require('../../core/schema');
const { nextNumber } = require('../../core/counters');
const { uploadLimiter } = require('../../core/rateLimits');
const { audit } = require('../../core/audit');
const OrganizationUser = require('../../saas/models/OrganizationUser');
const D = require('../../core/dates');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');
const { track } = require('../../analytics/track');

const isStaffRole = req => req.ctx.role === 'STAFF';

const dateFilter = (q, field = 'createdAt') => {
  if (!q.from && !q.to) return {};
  const f = {};
  if (q.from) f.$gte = D.toDay(q.from);
  if (q.to) f.$lt = D.addDays(D.toDay(q.to), 1);
  return { [field]: f };
};

/** Staff only ever see / update work assigned to their staff record. */
const assignmentScope = req => {
  if (!isStaffRole(req)) return {};
  if (!req.ctx.staffId) return { assignedToStaffId: '__none__' };
  return { assignedToStaffId: req.ctx.staffId };
};

const assertAssigned = (req, doc) => {
  if (isStaffRole(req) && doc.assignedToStaffId !== req.ctx.staffId) throw errors.notFound('Task');
};

const loadStaff = async (req, staffId, propertyId) => {
  const staff = await Staff.findOne({ _id: staffId, organizationId: req.ctx.orgId, status: 'ACTIVE' }).lean();
  if (!staff) throw errors.notFound('Staff member');
  if (propertyId && staff.propertyIds && staff.propertyIds.length && !staff.propertyIds.includes(propertyId)) {
    throw errors.badRequest('This staff member is not assigned to that property.', 'STAFF_NOT_IN_PROPERTY');
  }
  return staff;
};

const staffUserId = async (organizationId, staffId) => {
  const m = await OrganizationUser.findOne({ organizationId, staffId, status: 'ACTIVE' }).select('userId').lean();
  return m ? m.userId : null;
};

const decorateWork = async (req, items) => {
  if (!items.length) return items;
  const organizationId = req.ctx.orgId;
  const [staff, tenants, rooms, props] = await Promise.all([
    Staff.find({ organizationId, _id: { $in: items.map(i => i.assignedToStaffId).filter(Boolean) } }).select('fullName phone').lean(),
    Tenant.find({ organizationId, _id: { $in: items.map(i => i.tenantId).filter(Boolean) } }).select('fullName').lean(),
    Room.find({ organizationId, _id: { $in: items.map(i => i.roomId).filter(Boolean) } }).select('roomNumber').lean(),
    PgProperty.find({ organizationId, _id: { $in: [...new Set(items.map(i => i.propertyId))] } }).select('name').lean(),
  ]);
  const m = rows => new Map(rows.map(x => [x._id, x]));
  const [so, to, ro, po] = [m(staff), m(tenants), m(rooms), m(props)];
  return items.map(i => ({
    ...i,
    images: undefined,
    imageCount: (i.images || []).length,
    assignedTo: i.assignedToStaffId && so.get(i.assignedToStaffId) ? { id: i.assignedToStaffId, fullName: so.get(i.assignedToStaffId).fullName } : null,
    tenantName: i.tenantId && to.get(i.tenantId) ? to.get(i.tenantId).fullName : null,
    roomNumber: i.roomId && ro.get(i.roomId) ? ro.get(i.roomId).roomNumber : null,
    propertyName: po.get(i.propertyId) ? po.get(i.propertyId).name : '',
  }));
};

const withImageUrls = doc => ({
  ...doc,
  images: (doc.images || []).map(img => ({ mimeType: img.mimeType, ...signedUrl(img.key, img.storageDriver, { mimeType: img.mimeType }) })),
});

// ==== Complaints =============================================================

const c = createRouter({ prefix: '/pg/complaints', tag: 'Complaints' });

c.get(
  '/',
  {
    permission: 'complaint.read',
    query: listQuery({
      status: z.enum(COMPLAINT_STATUSES).optional(),
      open: z.enum(['true', 'false']).optional(),
      category: z.enum(COMPLAINT_CATEGORIES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      propertyId: id.optional(),
      tenantId: id.optional(),
      assignedToStaffId: id.optional(),
      ...dateRange,
    }),
    summary: 'List complaints',
  },
  async req => {
    const q = req.valid.query;
    const filter = { organizationId: req.ctx.orgId, ...propertyScope(req, 'propertyId', q.propertyId), ...dateFilter(q), ...assignmentScope(req) };
    if (q.status) filter.status = q.status;
    else if (q.open === 'true') filter.status = { $in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] };
    if (q.category) filter.category = q.category;
    if (q.priority) filter.priority = q.priority;
    if (q.tenantId) filter.tenantId = q.tenantId;
    if (q.assignedToStaffId && !isStaffRole(req)) filter.assignedToStaffId = q.assignedToStaffId;
    const page = await paginate(
      Complaint,
      filter,
      listOptions(q, { sortable: ['createdAt', 'priority', 'status'], searchFields: ['title', 'complaintNumber'] }),
      { select: '-history' },
    );
    page.items = await decorateWork(req, page.items);
    return page;
  },
);

const CreateComplaintDto = z.object({
  propertyId: id,
  tenantId: id.optional(),
  roomId: id.optional(),
  category: z.enum(COMPLAINT_CATEGORIES),
  title: requiredText(120),
  description: text(2000).optional(),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
});

/** Shared by staff logging and tenant self-service. */
const createComplaint = async (req, data, raisedByRole) => {
  const organizationId = req.ctx.orgId;
  const property = await PgProperty.findOne({ organizationId, _id: data.propertyId }).select('_id').lean();
  if (!property) throw errors.notFound('Property');
  if (data.roomId && !(await Room.exists({ organizationId, _id: data.roomId, propertyId: data.propertyId }))) throw errors.notFound('Room');
  if (data.tenantId && !(await Tenant.exists({ organizationId, _id: data.tenantId }))) throw errors.notFound('Tenant');
  const complaint = await Complaint.create({
    organizationId,
    complaintNumber: await nextNumber(organizationId, 'CMP', 'CMP'),
    ...data,
    raisedByUserId: req.user._id,
    raisedByRole,
    history: [{ status: 'OPEN', byUserId: req.user._id, byName: req.user.fullName, note: 'Complaint raised' }],
  });
  audit(req, { action: 'complaint.create', entityType: 'Complaint', entityId: complaint._id, summary: complaint.title });
  track('complaint_created', { userId: req.user._id, organizationId, props: { category: complaint.category, priority: complaint.priority, by: raisedByRole } });
  memberUserIdsForProperty(organizationId, ['OWNER', 'PROPERTY_MANAGER', 'RECEPTIONIST'], data.propertyId)
    .then(userIds =>
      notify({
        userIds,
        organizationId,
        type: 'complaint_update',
        title: `New ${complaint.priority === 'URGENT' ? 'URGENT ' : ''}complaint`,
        body: `${complaint.complaintNumber}: ${complaint.title}`,
        data: { route: 'complaint', id: complaint._id },
      }),
    )
    .catch(() => {});
  return withImageUrls(complaint.toJSON());
};

c.post('/', { permission: 'complaint.create', body: CreateComplaintDto, success: 201, summary: 'Log a complaint' }, async req => {
  assertPropertyAccess(req, req.valid.body.propertyId);
  return createComplaint(req, req.valid.body, req.ctx.role);
});

c.get('/:id', { permission: 'complaint.read', params: idParams, summary: 'Complaint with history & photos' }, async req => {
  const doc = await loadOwned(Complaint, req.valid.params.id, req, { entity: 'Complaint', lean: true });
  assertAssigned(req, doc);
  const [decorated] = await decorateWork(req, [publicDoc(doc)]);
  return withImageUrls({ ...decorated, images: doc.images, history: doc.history });
});

/** Notify the resident who raised / owns the complaint. */
const notifyTenant = async (organizationId, complaint, title, body) => {
  if (!complaint.tenantId) return;
  const t = await Tenant.findOne({ organizationId, _id: complaint.tenantId }).select('userId').lean();
  if (t && t.userId) notify({ userIds: [t.userId], organizationId, type: 'complaint_update', title, body, data: { route: 'complaint', id: complaint._id } });
};

c.post(
  '/:id/assign',
  { permission: 'complaint.assign', params: idParams, body: z.object({ staffId: id, note: text(500).optional() }), summary: 'Assign to a staff member' },
  async req => {
    const doc = await loadOwned(Complaint, req.valid.params.id, req, { entity: 'Complaint' });
    const staff = await loadStaff(req, req.valid.body.staffId, doc.propertyId);
    if (['RESOLVED', 'CLOSED'].includes(doc.status)) throw errors.conflict('Re-open the complaint before assigning.', 'INVALID_TRANSITION');
    doc.assignedToStaffId = staff._id;
    if (doc.status === 'OPEN') transition(doc, 'ASSIGNED', COMPLAINT_FLOW, { userId: req.user._id, userName: req.user.fullName, note: req.valid.body.note || `Assigned to ${staff.fullName}` });
    else {
      doc.assignedAt = new Date();
      doc.history.push({ status: doc.status, byUserId: req.user._id, byName: req.user.fullName, note: `Re-assigned to ${staff.fullName}` });
    }
    await doc.save();
    audit(req, { action: 'complaint.assign', entityType: 'Complaint', entityId: doc._id, summary: staff.fullName });
    const uid = await staffUserId(req.ctx.orgId, staff._id);
    if (uid) notify({ userIds: [uid], organizationId: req.ctx.orgId, type: 'task_assigned', title: 'New complaint assigned', body: `${doc.complaintNumber}: ${doc.title}`, data: { route: 'complaint', id: doc._id } });
    notifyTenant(req.ctx.orgId, doc, 'Complaint assigned', `${staff.fullName} will look into ${doc.complaintNumber}.`);
    return withImageUrls(doc.toJSON());
  },
);

c.post(
  '/:id/status',
  {
    permission: 'complaint.update',
    params: idParams,
    body: z.object({ status: z.enum(COMPLAINT_STATUSES), note: text(1000).optional() }),
    summary: 'Move a complaint through its workflow',
  },
  async req => {
    const doc = await loadOwned(Complaint, req.valid.params.id, req, { entity: 'Complaint' });
    assertAssigned(req, doc);
    const { status, note } = req.valid.body;
    if (isStaffRole(req) && !['IN_PROGRESS', 'RESOLVED'].includes(status)) {
      throw errors.forbidden('Staff can mark work in progress or resolved.', 'PERMISSION_DENIED');
    }
    transition(doc, status, COMPLAINT_FLOW, { userId: req.user._id, userName: req.user.fullName, note });
    if (status === 'RESOLVED' && note) doc.resolutionNote = note;
    await doc.save();
    audit(req, { action: 'complaint.status', entityType: 'Complaint', entityId: doc._id, summary: `${status}${note ? `: ${note}` : ''}` });
    notifyTenant(req.ctx.orgId, doc, `Complaint ${status.toLowerCase().replace('_', ' ')}`, `${doc.complaintNumber}: ${doc.title}${note ? ` — ${note}` : ''}`);
    return withImageUrls(doc.toJSON());
  },
);

const imageUpload = (Model, entity) => async req => {
  const doc = await loadOwned(Model, req.valid.params.id, req, { entity });
  assertAssigned(req, doc);
  if ((doc.images || []).length >= 6) throw errors.badRequest('Up to 6 photos per record.', 'TOO_MANY_FILES');
  const stored = await storeUpload(req.file, `${req.ctx.orgId}/complaints/${doc._id}`, { imagesOnly: true });
  doc.images.push({ key: stored.key, mimeType: stored.mimeType, storageDriver: stored.driver });
  await doc.save();
  return withImageUrls(doc.toJSON());
};

c.post(
  '/:id/images',
  {
    permission: 'complaint.update',
    params: idParams,
    middleware: [uploadLimiter, uploadSingle('file', { imagesOnly: true })],
    multipart: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
    success: 201,
    summary: 'Attach a photo',
  },
  imageUpload(Complaint, 'Complaint'),
);

// Escalate a complaint into a tracked maintenance job.
c.post(
  '/:id/convert',
  {
    permission: 'maintenance.manage',
    params: idParams,
    body: z.object({ dueDate: dayKey.optional(), estimatedCost: z.coerce.number().min(0).max(10000000).optional() }),
    success: 201,
    summary: 'Create a maintenance task from a complaint',
  },
  async req => {
    const doc = await loadOwned(Complaint, req.valid.params.id, req, { entity: 'Complaint' });
    if (doc.maintenanceTaskId) throw errors.conflict('A maintenance task already exists for this complaint.', 'ALREADY_CONVERTED');
    const task = await MaintenanceTask.create({
      organizationId: req.ctx.orgId,
      taskNumber: await nextNumber(req.ctx.orgId, 'MNT', 'MNT'),
      title: doc.title,
      description: doc.description,
      category: TASK_CATEGORIES.includes(doc.category) ? doc.category : 'GENERAL',
      propertyId: doc.propertyId,
      roomId: doc.roomId,
      bedId: doc.bedId,
      complaintId: doc._id,
      priority: doc.priority,
      dueDate: req.valid.body.dueDate ? D.toDay(req.valid.body.dueDate) : null,
      estimatedCost: req.valid.body.estimatedCost || 0,
      createdBy: req.user._id,
      history: [{ status: 'CREATED', byUserId: req.user._id, byName: req.user.fullName, note: `From complaint ${doc.complaintNumber}` }],
    });
    doc.maintenanceTaskId = task._id;
    await doc.save();
    audit(req, { action: 'maintenance.create', entityType: 'MaintenanceTask', entityId: task._id, summary: `From ${doc.complaintNumber}` });
    return task.toJSON();
  },
);

// ==== Maintenance ============================================================

const m = createRouter({ prefix: '/pg/maintenance', tag: 'Maintenance' });

m.get(
  '/',
  {
    permission: 'maintenance.read',
    query: listQuery({
      status: z.enum(TASK_STATUSES).optional(),
      open: z.enum(['true', 'false']).optional(),
      category: z.enum(TASK_CATEGORIES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      propertyId: id.optional(),
      assignedToStaffId: id.optional(),
      ...dateRange,
    }),
    summary: 'List maintenance tasks',
  },
  async req => {
    const q = req.valid.query;
    const filter = { organizationId: req.ctx.orgId, ...propertyScope(req, 'propertyId', q.propertyId), ...dateFilter(q), ...assignmentScope(req) };
    if (q.status) filter.status = q.status;
    else if (q.open === 'true') filter.status = { $in: ['CREATED', 'ASSIGNED', 'IN_PROGRESS'] };
    if (q.category) filter.category = q.category;
    if (q.priority) filter.priority = q.priority;
    if (q.assignedToStaffId && !isStaffRole(req)) filter.assignedToStaffId = q.assignedToStaffId;
    const page = await paginate(
      MaintenanceTask,
      filter,
      listOptions(q, { sortable: ['createdAt', 'dueDate', 'priority'], searchFields: ['title', 'taskNumber'] }),
      { select: '-history' },
    );
    page.items = await decorateWork(req, page.items);
    return page;
  },
);

const TaskDto = z.object({
  title: requiredText(120),
  description: text(2000).optional(),
  category: z.enum(TASK_CATEGORIES).default('GENERAL'),
  propertyId: id,
  roomId: id.optional(),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  dueDate: dayKey.optional(),
  estimatedCost: z.coerce.number().min(0).max(10000000).optional(),
  assignedToStaffId: id.optional(),
  notes: text(1000).optional(),
});

m.post('/', { permission: 'maintenance.manage', body: TaskDto, success: 201, summary: 'Create a maintenance task' }, async req => {
  const organizationId = req.ctx.orgId;
  const b = req.valid.body;
  assertPropertyAccess(req, b.propertyId);
  if (!(await PgProperty.exists({ organizationId, _id: b.propertyId }))) throw errors.notFound('Property');
  if (b.roomId && !(await Room.exists({ organizationId, _id: b.roomId, propertyId: b.propertyId }))) throw errors.notFound('Room');
  let staff = null;
  if (b.assignedToStaffId) staff = await loadStaff(req, b.assignedToStaffId, b.propertyId);
  const task = await MaintenanceTask.create({
    ...b,
    organizationId,
    taskNumber: await nextNumber(organizationId, 'MNT', 'MNT'),
    dueDate: b.dueDate ? D.toDay(b.dueDate) : null,
    status: staff ? 'ASSIGNED' : 'CREATED',
    assignedAt: staff ? new Date() : null,
    createdBy: req.user._id,
    history: [
      { status: 'CREATED', byUserId: req.user._id, byName: req.user.fullName, note: 'Task created' },
      ...(staff ? [{ status: 'ASSIGNED', byUserId: req.user._id, byName: req.user.fullName, note: `Assigned to ${staff.fullName}` }] : []),
    ],
  });
  audit(req, { action: 'maintenance.create', entityType: 'MaintenanceTask', entityId: task._id, summary: task.title });
  if (staff) {
    const uid = await staffUserId(organizationId, staff._id);
    if (uid) notify({ userIds: [uid], organizationId, type: 'task_assigned', title: 'New maintenance task', body: `${task.taskNumber}: ${task.title}`, data: { route: 'task', id: task._id } });
  }
  return task.toJSON();
});

m.get('/:id', { permission: 'maintenance.read', params: idParams, summary: 'Maintenance task with history' }, async req => {
  const doc = await loadOwned(MaintenanceTask, req.valid.params.id, req, { entity: 'Task', lean: true });
  assertAssigned(req, doc);
  const [decorated] = await decorateWork(req, [publicDoc(doc)]);
  return { ...decorated, history: doc.history };
});

m.put(
  '/:id',
  {
    permission: 'maintenance.manage',
    params: idParams,
    body: TaskDto.omit({ propertyId: true, assignedToStaffId: true })
      .partial()
      .extend({
        roomId: id.nullable().optional(),
        dueDate: dayKey.nullable().optional(),
        actualCost: z.coerce.number().min(0).max(10000000).optional(),
      }),
    summary: 'Edit a maintenance task',
  },
  async req => {
    const doc = await loadOwned(MaintenanceTask, req.valid.params.id, req, { entity: 'Task' });
    const b = req.valid.body;
    if (b.roomId && !(await Room.exists({ organizationId: req.ctx.orgId, _id: b.roomId, propertyId: doc.propertyId }))) throw errors.notFound('Room');
    doc.set({ ...b, ...(b.dueDate ? { dueDate: D.toDay(b.dueDate) } : {}) });
    await doc.save();
    audit(req, { action: 'maintenance.update', entityType: 'MaintenanceTask', entityId: doc._id, changes: b });
    return doc.toJSON();
  },
);

m.post(
  '/:id/assign',
  { permission: 'maintenance.assign', params: idParams, body: z.object({ staffId: id, note: text(500).optional() }), summary: 'Assign to staff' },
  async req => {
    const doc = await loadOwned(MaintenanceTask, req.valid.params.id, req, { entity: 'Task' });
    const staff = await loadStaff(req, req.valid.body.staffId, doc.propertyId);
    if (['RESOLVED', 'CLOSED'].includes(doc.status)) throw errors.conflict('This task is already finished.', 'INVALID_TRANSITION');
    doc.assignedToStaffId = staff._id;
    if (doc.status === 'CREATED') transition(doc, 'ASSIGNED', MAINTENANCE_FLOW, { userId: req.user._id, userName: req.user.fullName, note: req.valid.body.note || `Assigned to ${staff.fullName}` });
    else {
      doc.assignedAt = new Date();
      doc.history.push({ status: doc.status, byUserId: req.user._id, byName: req.user.fullName, note: `Re-assigned to ${staff.fullName}` });
    }
    await doc.save();
    audit(req, { action: 'maintenance.assign', entityType: 'MaintenanceTask', entityId: doc._id, summary: staff.fullName });
    const uid = await staffUserId(req.ctx.orgId, staff._id);
    if (uid) notify({ userIds: [uid], organizationId: req.ctx.orgId, type: 'task_assigned', title: 'Maintenance task assigned', body: `${doc.taskNumber}: ${doc.title}`, data: { route: 'task', id: doc._id } });
    return doc.toJSON();
  },
);

m.post(
  '/:id/status',
  {
    permission: 'maintenance.update',
    params: idParams,
    body: z.object({ status: z.enum(TASK_STATUSES), note: text(1000).optional(), actualCost: z.coerce.number().min(0).max(10000000).optional() }),
    summary: 'Move a task through its workflow',
  },
  async req => {
    const doc = await loadOwned(MaintenanceTask, req.valid.params.id, req, { entity: 'Task' });
    assertAssigned(req, doc);
    const { status, note, actualCost } = req.valid.body;
    if (isStaffRole(req) && !['IN_PROGRESS', 'RESOLVED'].includes(status)) {
      throw errors.forbidden('Staff can mark work in progress or resolved.', 'PERMISSION_DENIED');
    }
    transition(doc, status, MAINTENANCE_FLOW, { userId: req.user._id, userName: req.user.fullName, note });
    if (actualCost !== undefined) doc.actualCost = actualCost;
    await doc.save();
    // Closing the task resolves its originating complaint.
    if (status === 'RESOLVED' && doc.complaintId) {
      const complaint = await Complaint.findOne({ organizationId: req.ctx.orgId, _id: doc.complaintId });
      if (complaint && ['OPEN', 'ASSIGNED', 'IN_PROGRESS'].includes(complaint.status)) {
        transition(complaint, 'RESOLVED', COMPLAINT_FLOW, { userId: req.user._id, userName: req.user.fullName, note: `Resolved via ${doc.taskNumber}` });
        complaint.resolutionNote = note || `Resolved via ${doc.taskNumber}`;
        await complaint.save();
        notifyTenant(req.ctx.orgId, complaint, 'Complaint resolved', `${complaint.complaintNumber}: ${complaint.title}`);
      }
    }
    audit(req, { action: 'maintenance.status', entityType: 'MaintenanceTask', entityId: doc._id, summary: status });
    return doc.toJSON();
  },
);

module.exports = { complaintsRouter: c.router, maintenanceRouter: m.router, createComplaint, withImageUrls, decorateWork, imageUpload };
