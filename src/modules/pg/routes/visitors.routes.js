const { createRouter } = require('../../core/router');
const { z, text, requiredText, phone, id, idParams, listQuery, dateRange } = require('../../core/validation');
const Visitor = require('../models/Visitor');
const VisitorEntry = require('../models/VisitorEntry');
const Tenant = require('../models/Tenant');
const { STATUSES } = require('../models/Visitor');
const { passCode, maskIdNumber, assertVisitorTransition } = require('../services/visitors');
const { memberUserIdsForProperty } = require('../../saas/services/members');
const { listOptions, paginate } = require('../../core/query');
const { loadOwned } = require('../../core/refs');
const { propertyScope } = require('../../core/context');
const { publicDoc } = require('../../core/schema');
const { withTransaction } = require('../../core/tx');
const { audit } = require('../../core/audit');
const D = require('../../core/dates');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');

const ID_TYPES = ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'OTHER'];

const r = createRouter({ prefix: '/pg/visitors', tag: 'Visitors' });

const withTenants = async (req, items) => {
  const tenants = await Tenant.find({ organizationId: req.ctx.orgId, _id: { $in: [...new Set(items.map(v => v.tenantId))] } })
    .select('fullName phone current')
    .lean();
  const of = new Map(tenants.map(t => [t._id, t]));
  return items.map(v => ({ ...v, tenantName: (of.get(v.tenantId) || {}).fullName || '' }));
};

r.get(
  '/',
  {
    permission: 'visitor.read',
    feature: 'visitorManagement',
    query: listQuery({ status: z.enum(STATUSES).optional(), propertyId: id.optional(), tenantId: id.optional(), today: z.enum(['true', 'false']).optional(), ...dateRange }),
    summary: 'Visitor passes (gate console)',
  },
  async req => {
    const q = req.valid.query;
    const filter = { organizationId: req.ctx.orgId, ...propertyScope(req, 'propertyId', q.propertyId) };
    if (q.status) filter.status = q.status;
    if (q.tenantId) filter.tenantId = q.tenantId;
    if (q.today === 'true') {
      const today = D.todayIn(req.ctx.org.settings && req.ctx.org.settings.timezone);
      filter.expectedAt = { $gte: D.addDays(today, -1), $lt: D.addDays(today, 2) };
    } else if (q.from || q.to) {
      filter.expectedAt = {};
      if (q.from) filter.expectedAt.$gte = D.toDay(q.from);
      if (q.to) filter.expectedAt.$lt = D.addDays(D.toDay(q.to), 1);
    }
    const page = await paginate(
      Visitor,
      filter,
      listOptions(q, { sortable: ['expectedAt', 'createdAt', 'status'], defaultSort: '-expectedAt', searchFields: ['visitorName', 'visitorPhone', 'passCode'] }),
    );
    page.items = await withTenants(req, page.items);
    return page;
  },
);

const VisitorDto = z.object({
  tenantId: id,
  visitorName: requiredText(100),
  visitorPhone: phone,
  idType: z.enum(ID_TYPES).optional(),
  idNumber: z.string().trim().max(40).optional(),
  purpose: text(200).optional(),
  guests: z.coerce.number().int().min(1).max(20).default(1),
  vehicleNumber: text(20).optional(),
  expectedAt: z.string().datetime().optional(),
  validHours: z.coerce.number().int().min(1).max(72).default(12),
  notes: text(500).optional(),
});

/** Shared by walk-in registration (security) and tenant requests. */
const createVisitor = async (req, body, { status, requestedByRole }) => {
  const tenant = await Tenant.findOne({ organizationId: req.ctx.orgId, _id: body.tenantId, status: { $in: ['ACTIVE', 'NOTICE'] } }).lean();
  if (!tenant || !tenant.current || !tenant.current.propertyId) throw errors.notFound('Resident');
  const expectedAt = body.expectedAt ? new Date(body.expectedAt) : new Date();
  const visitor = await Visitor.create({
    organizationId: req.ctx.orgId,
    passCode: passCode(),
    tenantId: tenant._id,
    propertyId: tenant.current.propertyId,
    visitorName: body.visitorName,
    visitorPhone: body.visitorPhone,
    idType: body.idType || null,
    idNumberMasked: maskIdNumber(body.idNumber),
    purpose: body.purpose || '',
    guests: body.guests,
    vehicleNumber: body.vehicleNumber || '',
    expectedAt,
    validUntil: new Date(expectedAt.getTime() + body.validHours * 3600 * 1000),
    status,
    requestedByUserId: req.user._id,
    requestedByRole,
    ...(status === 'APPROVED' ? { decidedByUserId: req.user._id, decidedAt: new Date() } : {}),
    notes: body.notes || '',
  });
  return { visitor: visitor.toJSON(), tenant };
};

// Walk-in at the gate: security registers the visitor; the resident is
// informed. Walk-ins are pre-approved by security.
r.post('/', { permission: 'visitor.create', feature: 'visitorManagement', body: VisitorDto, success: 201, summary: 'Register a walk-in visitor' }, async req => {
  const { visitor, tenant } = await createVisitor(req, req.valid.body, { status: 'APPROVED', requestedByRole: req.ctx.role });
  audit(req, { action: 'visitor.walkin', entityType: 'Visitor', entityId: visitor.id, summary: visitor.visitorName });
  if (tenant.userId) {
    notify({ userIds: [tenant.userId], organizationId: req.ctx.orgId, type: 'visitor_update', title: 'Visitor at the gate', body: `${visitor.visitorName} is here to see you.`, data: { route: 'visitor', id: visitor.id } });
  }
  return visitor;
});

r.get('/verify/:code', { permission: 'visitor.read', feature: 'visitorManagement', params: z.object({ code: z.string().regex(/^\d{6}$/) }), summary: 'Look up a pass by its 6-digit code' }, async req => {
  const visitor = await Visitor.findOne({
    organizationId: req.ctx.orgId,
    passCode: req.valid.params.code,
    status: { $in: ['REQUESTED', 'APPROVED', 'CHECKED_IN'] },
    ...propertyScope(req, 'propertyId'),
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!visitor) throw errors.notFound('Visitor pass');
  const [withName] = await withTenants(req, [publicDoc(visitor)]);
  return withName;
});

r.get('/:id', { permission: 'visitor.read', feature: 'visitorManagement', params: idParams, summary: 'Visitor pass with gate log' }, async req => {
  const visitor = await loadOwned(Visitor, req.valid.params.id, req, { entity: 'Visitor', lean: true });
  const entries = await VisitorEntry.find({ organizationId: req.ctx.orgId, visitorId: visitor._id }).sort({ entryAt: -1 }).lean();
  const [withName] = await withTenants(req, [publicDoc(visitor)]);
  return { ...withName, entries: entries.map(publicDoc) };
});

const act = (to, permission, summary) =>
  r.post(
    `/:id/${to === 'APPROVED' ? 'approve' : to === 'REJECTED' ? 'reject' : to === 'CHECKED_IN' ? 'checkin' : 'checkout'}`,
    { permission, feature: 'visitorManagement', params: idParams, body: z.object({ reason: text(300).optional(), notes: text(300).optional() }), summary },
    async req => {
      const organizationId = req.ctx.orgId;
      const visitor = await loadOwned(Visitor, req.valid.params.id, req, { entity: 'Visitor' });
      assertVisitorTransition(visitor, to);
      const now = new Date();
      await withTransaction(async session => {
        const set = { status: to };
        if (to === 'APPROVED' || to === 'REJECTED') {
          set.decidedByUserId = req.user._id;
          set.decidedAt = now;
          if (to === 'REJECTED') set.rejectionReason = req.valid.body.reason || '';
        }
        if (to === 'CHECKED_IN') {
          set.checkedInAt = now;
          await VisitorEntry.create(
            [{ organizationId, visitorId: visitor._id, propertyId: visitor.propertyId, tenantId: visitor.tenantId, entryAt: now, entryGuardUserId: req.user._id, notes: req.valid.body.notes || '' }],
            { session: session || undefined },
          );
        }
        if (to === 'CHECKED_OUT') {
          set.checkedOutAt = now;
          await VisitorEntry.updateOne(
            { organizationId, visitorId: visitor._id, exitAt: null },
            { $set: { exitAt: now, exitGuardUserId: req.user._id } },
            { session: session || undefined },
          );
        }
        const updated = await Visitor.updateOne({ _id: visitor._id, organizationId, status: visitor.status }, { $set: set }, { session: session || undefined });
        if (!updated.modifiedCount) throw errors.conflict('This pass was just updated. Please refresh.', 'CONCURRENT_UPDATE');
      });
      audit(req, { action: `visitor.${to.toLowerCase()}`, entityType: 'Visitor', entityId: visitor._id, summary: req.valid.body.reason || visitor.visitorName });
      const tenant = await Tenant.findOne({ organizationId, _id: visitor.tenantId }).select('userId').lean();
      if (tenant && tenant.userId) {
        const text = {
          APPROVED: `Your visitor ${visitor.visitorName} is approved. Pass code ${visitor.passCode}.`,
          REJECTED: `Your visitor ${visitor.visitorName} was not approved.${req.valid.body.reason ? ` ${req.valid.body.reason}` : ''}`,
          CHECKED_IN: `${visitor.visitorName} has entered the premises.`,
          CHECKED_OUT: `${visitor.visitorName} has left the premises.`,
        }[to];
        notify({ userIds: [tenant.userId], organizationId, type: 'visitor_update', title: 'Visitor update', body: text, data: { route: 'visitor', id: visitor._id } });
      }
      return publicDoc(await Visitor.findOne({ _id: visitor._id, organizationId }).lean());
    },
  );

act('APPROVED', 'visitor.approve', 'Approve a visitor request');
act('REJECTED', 'visitor.approve', 'Reject a visitor request');
act('CHECKED_IN', 'visitor.checkin', 'Check a visitor in at the gate');
act('CHECKED_OUT', 'visitor.checkin', 'Check a visitor out');

/** Notify security on duty when a tenant requests a visitor. */
const notifySecurity = (organizationId, visitor) =>
  memberUserIdsForProperty(organizationId, ['SECURITY', 'RECEPTIONIST', 'PROPERTY_MANAGER'], visitor.propertyId)
    .then(userIds =>
      notify({
        userIds,
        organizationId,
        type: 'visitor_update',
        title: 'New visitor request',
        body: `${visitor.visitorName} expected ${new Date(visitor.expectedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}.`,
        data: { route: 'visitor', id: visitor.id },
      }),
    )
    .catch(() => {});

module.exports = { router: r.router, createVisitor, VisitorDto, notifySecurity };
