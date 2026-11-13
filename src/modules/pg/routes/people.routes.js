const { createRouter } = require('../../core/router');
const { z, text, requiredText, phone, email, id, idParams, listQuery, dayKey } = require('../../core/validation');
const Staff = require('../models/Staff');
const StaffAttendance = require('../models/StaffAttendance');
const PgProperty = require('../models/PgProperty');
const OrganizationUser = require('../../saas/models/OrganizationUser');
const { JOB_ROLES, DEPARTMENTS } = require('../models/Staff');
const { crud } = require('./_crud');
const { findOrCreateUserByPhone, ensureMembership } = require('../services/accounts');
const { assertLimit } = require('../../saas/services/entitlements');
const { ROLE_DEFS } = require('../../core/permissions');
const { loadOwned } = require('../../core/refs');
const { withTransaction } = require('../../core/tx');
const { audit } = require('../../core/audit');
const D = require('../../core/dates');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');

const assertProperties = async (organizationId, ids) => {
  const unique = [...new Set(ids || [])];
  if (!unique.length) return [];
  if ((await PgProperty.countDocuments({ organizationId, _id: { $in: unique } })) !== unique.length) throw errors.notFound('Property');
  return unique;
};

// ==== Staff ==================================================================

const s = createRouter({ prefix: '/pg/staff', tag: 'Staff' });

const staffBase = {
  fullName: requiredText(100),
  phone,
  email: email.optional().or(z.literal('')),
  jobRole: z.enum(JOB_ROLES),
  department: z.enum(DEPARTMENTS),
  propertyIds: z.array(id).max(50).optional(),
  salary: z.coerce.number().min(0).max(10000000).optional(),
  joinedAt: dayKey.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  address: text(300).optional(),
  emergencyContact: z.object({ name: text(80).optional(), phone: phone.optional().or(z.literal('')) }).optional(),
  notes: text(1000).optional(),
};

crud(s, Staff, {
  entity: 'Staff member',
  propertyField: null,
  feature: 'staffManagement',
  permissions: { read: 'staff.read', create: 'staff.manage', update: 'staff.manage', delete: 'staff.manage' },
  dto: {
    list: listQuery({ department: z.enum(DEPARTMENTS).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(), propertyId: id.optional() }),
    create: z.object(staffBase),
    update: z.object(staffBase).partial(),
  },
  sortable: ['fullName', 'createdAt', 'department'],
  defaultSort: 'fullName',
  searchFields: ['fullName', 'phone', 'email'],
  auditPrefix: 'staff',
  listFilter: (req, q) => {
    const f = {};
    if (q.department) f.department = q.department;
    if (q.status) f.status = q.status;
    if (q.propertyId) f.$or = [{ propertyIds: q.propertyId }, { propertyIds: { $size: 0 } }];
    else if (req.ctx.propertyIds) f.$or = [{ propertyIds: { $in: req.ctx.propertyIds } }, { propertyIds: { $size: 0 } }];
    return f;
  },
  beforeCreate: async (req, data) => ({
    ...data,
    propertyIds: await assertProperties(req.ctx.orgId, data.propertyIds),
    joinedAt: data.joinedAt ? D.toDay(data.joinedAt) : null,
  }),
  beforeUpdate: async (req, _doc, data) => ({
    ...data,
    ...(data.propertyIds ? { propertyIds: await assertProperties(req.ctx.orgId, data.propertyIds) } : {}),
    ...(data.joinedAt ? { joinedAt: D.toDay(data.joinedAt) } : {}),
  }),
  beforeDelete: async (req, doc) => {
    if (doc.membershipId) {
      await OrganizationUser.updateOne({ _id: doc.membershipId, organizationId: req.ctx.orgId }, { $set: { status: 'DISABLED' } });
    }
  },
});

const AccessDto = z.object({ role: z.enum(['STAFF', 'SECURITY', 'RECEPTIONIST', 'ACCOUNTANT', 'PROPERTY_MANAGER']) });

// Give a staff member their own login (OTP with their phone number).
s.post('/:id/app-access', { permission: 'org.members.manage', feature: 'staffManagement', params: idParams, body: AccessDto, success: 201, summary: 'Grant app access to a staff member' }, async req => {
  const organizationId = req.ctx.orgId;
  const staff = await loadOwned(Staff, req.valid.params.id, req, { entity: 'Staff member', propertyField: null });
  if (staff.membershipId) throw errors.conflict('This staff member already has app access.', 'ALREADY_MEMBER');
  await assertLimit(organizationId, 'maxUsers', 1);
  const result = await withTransaction(async session => {
    const user = await findOrCreateUserByPhone({ phone: staff.phone, fullName: staff.fullName, email: staff.email }, session);
    const { membership, created } = await ensureMembership(
      {
        organizationId,
        userId: user._id,
        role: req.valid.body.role,
        status: 'INVITED',
        staffId: staff._id,
        propertyIds: staff.propertyIds || [],
        displayName: staff.fullName,
        phone: staff.phone,
        email: staff.email,
        invitedBy: req.user._id,
      },
      session,
    );
    if (!created) throw errors.conflict('This phone number is already a member of your organization.', 'ALREADY_MEMBER');
    staff.userId = user._id;
    staff.membershipId = membership._id;
    await staff.save({ session: session || undefined });
    return { membership: membership.toJSON(), userId: user._id };
  });
  audit(req, { action: 'staff.app_access', entityType: 'Staff', entityId: staff._id, summary: req.valid.body.role });
  notify({
    userIds: [result.userId],
    organizationId,
    type: 'team',
    title: `You're invited to ${req.ctx.org.name}`,
    body: `You were added as ${ROLE_DEFS[req.valid.body.role].name}. Open the PG app to accept.`,
    data: { route: 'invitations' },
    channels: ['inapp', 'push', 'sms'],
  });
  return result.membership;
});

s.delete('/:id/app-access', { permission: 'org.members.manage', params: idParams, summary: 'Revoke app access' }, async req => {
  const staff = await loadOwned(Staff, req.valid.params.id, req, { entity: 'Staff member', propertyField: null });
  if (!staff.membershipId) throw errors.conflict('This staff member has no app access.', 'NO_ACCESS');
  await OrganizationUser.deleteOne({ _id: staff.membershipId, organizationId: req.ctx.orgId });
  staff.membershipId = null;
  await staff.save();
  audit(req, { action: 'staff.app_access.revoke', entityType: 'Staff', entityId: staff._id });
  return staff.toJSON();
});

// ==== Attendance =============================================================

const a = createRouter({ prefix: '/pg/attendance', tag: 'Staff' });

const ATT = ['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'HOLIDAY'];

a.get(
  '/',
  { permission: 'attendance.read', feature: 'staffManagement', query: z.object({ date: dayKey.optional(), propertyId: id.optional() }), summary: 'Attendance sheet for a day' },
  async req => {
    const organizationId = req.ctx.orgId;
    const q = req.valid.query;
    const date = q.date ? D.toDay(q.date) : D.todayIn(req.ctx.org.settings && req.ctx.org.settings.timezone);
    const staffFilter = { organizationId, status: 'ACTIVE' };
    const scope = q.propertyId ? [q.propertyId] : req.ctx.propertyIds;
    if (scope) staffFilter.$or = [{ propertyIds: { $in: scope } }, { propertyIds: { $size: 0 } }];
    if (req.ctx.role === 'STAFF') staffFilter._id = req.ctx.staffId || '__none__';
    const staff = await Staff.find(staffFilter).sort({ fullName: 1 }).select('fullName jobRole department').lean();
    const marks = await StaffAttendance.find({ organizationId, dateKey: D.dayKey(date), staffId: { $in: staff.map(x => x._id) } }).lean();
    const markOf = new Map(marks.map(m => [m.staffId, m]));
    return {
      date: D.dayKey(date),
      rows: staff.map(x => {
        const mk = markOf.get(x._id);
        return {
          staffId: x._id,
          fullName: x.fullName,
          jobRole: x.jobRole,
          department: x.department,
          status: mk ? mk.status : null,
          checkInAt: mk ? mk.checkInAt : null,
          checkOutAt: mk ? mk.checkOutAt : null,
          note: mk ? mk.note : '',
        };
      }),
    };
  },
);

const MarkDto = z.object({
  date: dayKey,
  entries: z
    .array(
      z.object({
        staffId: id,
        status: z.enum(ATT),
        checkInAt: z.string().datetime().optional(),
        checkOutAt: z.string().datetime().optional(),
        note: text(300).optional(),
      }),
    )
    .min(1)
    .max(200),
});

a.post('/', { permission: 'attendance.mark', feature: 'staffManagement', body: MarkDto, summary: 'Mark attendance (bulk, upsert)' }, async req => {
  const organizationId = req.ctx.orgId;
  const { date, entries } = req.valid.body;
  const ids = [...new Set(entries.map(e => e.staffId))];
  if ((await Staff.countDocuments({ organizationId, _id: { $in: ids } })) !== ids.length) throw errors.notFound('Staff member');
  const day = D.toDay(date);
  const today = D.todayIn(req.ctx.org.settings && req.ctx.org.settings.timezone);
  if (day > today) throw errors.badRequest('Attendance cannot be marked for a future date.', 'VALIDATION_ERROR');
  await Promise.all(
    entries.map(e =>
      StaffAttendance.updateOne(
        { organizationId, staffId: e.staffId, dateKey: date },
        {
          // Omitted times / notes keep what was recorded earlier.
          $set: {
            status: e.status,
            date: day,
            markedBy: req.user._id,
            ...(e.checkInAt !== undefined ? { checkInAt: new Date(e.checkInAt) } : {}),
            ...(e.checkOutAt !== undefined ? { checkOutAt: new Date(e.checkOutAt) } : {}),
            ...(e.note !== undefined ? { note: e.note } : {}),
          },
        },
        { upsert: true },
      ),
    ),
  );
  audit(req, { action: 'attendance.mark', entityType: 'StaffAttendance', entityId: date, summary: `${entries.length} entries` });
  return { date, marked: entries.length };
});

a.get(
  '/staff/:id',
  { permission: 'attendance.read', feature: 'staffManagement', params: idParams, query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }), summary: 'Monthly attendance for one staff member' },
  async req => {
    const organizationId = req.ctx.orgId;
    const staff = await loadOwned(Staff, req.valid.params.id, req, { entity: 'Staff member', propertyField: null, lean: true });
    if (req.ctx.role === 'STAFF' && req.ctx.staffId !== staff._id) throw errors.notFound('Staff member');
    const month = req.valid.query.month || D.dayKey(D.todayIn()).slice(0, 7);
    const start = D.parseDay(`${month}-01`);
    const rows = await StaffAttendance.find({ organizationId, staffId: staff._id, date: { $gte: start, $lt: D.addMonths(start, 1) } }).sort({ date: 1 }).lean();
    const summary = Object.fromEntries(ATT.map(k => [k, rows.filter(r => r.status === k).length]));
    return { staff: { id: staff._id, fullName: staff.fullName }, month, summary, days: rows.map(r => ({ date: r.dateKey, status: r.status, checkInAt: r.checkInAt, checkOutAt: r.checkOutAt, note: r.note })) };
  },
);

module.exports = { staffRouter: s.router, attendanceRouter: a.router };
