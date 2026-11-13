const { createRouter } = require('../../core/router');
const { z, id, listQuery, dateRange } = require('../../core/validation');
const Notification = require('../../../models/Notification');
const Complaint = require('../models/Complaint');
const MaintenanceTask = require('../models/MaintenanceTask');
const { REPORTS, resolveRange } = require('../services/reports');
const { ownerDashboard } = require('../services/dashboard');
const { decorateWork } = require('./ops.routes');
const { assertFeature } = require('../../saas/services/entitlements');
const { assertPropertyAccess } = require('../../core/context');
const { sendCsv } = require('../../core/csv');
const { track } = require('../../analytics/track');
const { publicDoc } = require('../../core/schema');
const D = require('../../core/dates');
const errors = require('../../core/errors');

// ==== Dashboard ================================================================

const dash = createRouter({ prefix: '/pg/dashboard', tag: 'Dashboard' });

dash.get('/', { permission: 'dashboard.read', query: z.object({ propertyId: id.optional() }), summary: 'Owner dashboard KPIs' }, async req => {
  if (req.valid.query.propertyId) assertPropertyAccess(req, req.valid.query.propertyId);
  track('pg_dashboard_viewed', { userId: req.user._id, organizationId: req.ctx.orgId, props: { role: req.ctx.role } });
  return ownerDashboard(req, req.valid.query);
});

// ==== Reports ==================================================================

const rep = createRouter({ prefix: '/pg/reports', tag: 'Reports' });

rep.get('/', { permission: 'report.read', summary: 'Available reports' }, async () =>
  Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, advanced: r.advanced })),
);

rep.get(
  '/:name',
  {
    permission: 'report.read',
    params: z.object({ name: z.enum(Object.keys(REPORTS)) }),
    query: z.object({
      ...dateRange,
      propertyId: id.optional(),
      method: z.string().max(30).optional(),
      status: z.string().max(30).optional(),
      format: z.enum(['json', 'csv']).default('json'),
    }),
    raw: true,
    summary: 'Run a report (JSON, or CSV with format=csv)',
  },
  async (req, res) => {
    const { name } = req.valid.params;
    const q = req.valid.query;
    const report = REPORTS[name];
    if (report.advanced) {
      if (!req.ctx.permissions.has('report.advanced')) throw errors.forbidden('Advanced reports are not available for your role.', 'PERMISSION_DENIED');
      await assertFeature(req.ctx.orgId, 'advancedReports');
    }
    if (q.format === 'csv') {
      if (!req.ctx.permissions.has('report.export')) throw errors.forbidden('Exporting reports is not available for your role.', 'PERMISSION_DENIED');
      await assertFeature(req.ctx.orgId, 'exportReports');
    }
    if (q.propertyId) assertPropertyAccess(req, q.propertyId);
    // Members limited to one property are pinned to it.
    const scoped = req.ctx.propertyIds;
    if (scoped && !q.propertyId && scoped.length !== 1) {
      throw errors.badRequest('Choose one of your properties to run this report.', 'PROPERTY_REQUIRED');
    }
    const propertyFilter = q.propertyId || (scoped ? scoped[0] : undefined);
    const tz = (req.ctx.org.settings && req.ctx.org.settings.timezone) || undefined;
    const today = D.todayIn(tz);
    const range = resolveRange(q, today);
    if (D.diffDays(range.start, range.endExclusive) > 3 * 366) throw errors.badRequest('Please choose a range of at most 3 years.', 'RANGE_TOO_LARGE');
    const data = await report.fn(req.ctx.orgId, { propertyFilter, method: q.method, status: q.status, tz }, range, today);
    if (q.format === 'csv') {
      return sendCsv(res, `${name}_${range.from}_${range.to}.csv`, data.table.columns, data.table.rows);
    }
    res.json({ success: true, data: { report: name, title: report.title, range: { from: range.from, to: range.to }, propertyId: propertyFilter || null, ...data } });
  },
);

// ==== PG notifications ============================================================

const inbox = createRouter({ prefix: '/pg/notifications', tag: 'Notifications' });

inbox.get('/', { query: listQuery({ unread: z.enum(['true', 'false']).optional() }), summary: 'My PG notifications (current organization)' }, async req => {
  const q = req.valid.query;
  const filter = { userId: req.user._id, module: 'pg', organizationId: req.ctx.orgId };
  if (q.unread === 'true') filter.read = false;
  const page = Math.max(1, q.page || 1);
  const pageSize = Math.min(100, q.pageSize || 30);
  const [items, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Notification.countDocuments(filter),
  ]);
  return {
    items: items.map(i => ({ id: String(i._id), type: i.type, title: i.title, body: i.body, read: i.read, data: i.data || null, createdAt: i.createdAt })),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
});

inbox.get('/unread-count', { summary: 'Unread PG notification count' }, async req => ({
  count: await Notification.countDocuments({ userId: req.user._id, module: 'pg', organizationId: req.ctx.orgId, read: false }),
}));

inbox.post('/read-all', { write: false, summary: 'Mark all read' }, async req => {
  await Notification.updateMany({ userId: req.user._id, module: 'pg', organizationId: req.ctx.orgId, read: false }, { read: true });
  return { success: true };
});

inbox.post('/:id/read', { write: false, params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) }), summary: 'Mark one read' }, async req => {
  await Notification.updateOne({ _id: req.valid.params.id, userId: req.user._id, module: 'pg' }, { read: true });
  return { success: true };
});

// ==== Staff: my work ================================================================

const work = createRouter({ prefix: '/pg/work', tag: 'Staff' });

work.get('/', { anyPermission: ['complaint.read', 'maintenance.read'], summary: 'Complaints & tasks assigned to me' }, async req => {
  if (!req.ctx.staffId) return { complaints: [], tasks: [] };
  const organizationId = req.ctx.orgId;
  const [complaints, tasks] = await Promise.all([
    Complaint.find({ organizationId, assignedToStaffId: req.ctx.staffId, status: { $in: ['ASSIGNED', 'IN_PROGRESS', 'OPEN'] } })
      .sort({ priority: -1, createdAt: 1 })
      .select('-history')
      .lean(),
    MaintenanceTask.find({ organizationId, assignedToStaffId: req.ctx.staffId, status: { $in: ['ASSIGNED', 'IN_PROGRESS', 'CREATED'] } })
      .sort({ dueDate: 1, createdAt: 1 })
      .select('-history')
      .lean(),
  ]);
  return {
    complaints: await decorateWork(req, complaints.map(publicDoc)),
    tasks: await decorateWork(req, tasks.map(publicDoc)),
  };
});

module.exports = {
  dashboardRouter: dash.router,
  reportsRouter: rep.router,
  notificationsRouter: inbox.router,
  workRouter: work.router,
};
