const { createRouter } = require('../../core/router');
const { z, phone, email, text, id, idParams, listQuery } = require('../../core/validation');
const OrganizationUser = require('../models/OrganizationUser');
const Organization = require('../models/Organization');
const PgProperty = require('../../pg/models/PgProperty');
const Staff = require('../../pg/models/Staff');
const { ASSIGNABLE_ROLES, ROLE_DEFS } = require('../../core/permissions');
const { findOrCreateUserByPhone, ensureMembership } = require('../../pg/services/accounts');
const { assertLimit } = require('../services/entitlements');
const { listOptions, paginate } = require('../../core/query');
const { unscoped } = require('../../core/scope');
const { audit } = require('../../core/audit');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');

// Team management (the /users module): invite staff-side members, change
// roles / property scope, disable or remove access.
const r = createRouter({ prefix: '/pg/users', tag: 'Team' });

const RoleEnum = z.enum(ASSIGNABLE_ROLES);

const assertProperties = async (organizationId, propertyIds) => {
  const ids = [...new Set(propertyIds || [])];
  if (!ids.length) return [];
  const count = await PgProperty.countDocuments({ organizationId, _id: { $in: ids } });
  if (count !== ids.length) throw errors.notFound('Property');
  return ids;
};

r.get(
  '/',
  {
    permission: 'org.members.read',
    query: listQuery({ role: z.enum([...ASSIGNABLE_ROLES, 'TENANT']).optional(), status: z.enum(['INVITED', 'ACTIVE', 'DISABLED']).optional() }),
    summary: 'List team members',
  },
  async req => {
    const q = req.valid.query;
    const filter = { organizationId: req.ctx.orgId, role: q.role || { $ne: 'TENANT' } };
    if (q.status) filter.status = q.status;
    return paginate(
      OrganizationUser,
      filter,
      listOptions(q, { sortable: ['createdAt', 'displayName', 'role'], defaultSort: 'displayName', searchFields: ['displayName', 'phone', 'email'] }),
    );
  },
);

r.get('/roles', { permission: 'org.members.read', summary: 'Assignable roles and their permissions' }, async () =>
  ASSIGNABLE_ROLES.map(key => ({ key, name: ROLE_DEFS[key].name, description: ROLE_DEFS[key].description, permissions: ROLE_DEFS[key].permissions })),
);

const InviteDto = z.object({
  phone,
  fullName: text(100).min(2),
  email: email.optional(),
  role: RoleEnum,
  propertyIds: z.array(id).max(100).optional(),
});

r.post('/invite', { permission: 'org.members.manage', body: InviteDto, success: 201, summary: 'Invite a team member' }, async req => {
  const organizationId = req.ctx.orgId;
  const body = req.valid.body;
  if (body.role === 'OWNER' && req.ctx.role !== 'OWNER') throw errors.forbidden('Only owners can add owners.', 'PERMISSION_DENIED');
  await assertLimit(organizationId, 'maxUsers', 1);
  const propertyIds = await assertProperties(organizationId, body.propertyIds);
  const user = await findOrCreateUserByPhone({ phone: body.phone, fullName: body.fullName, email: body.email });
  if (user.role === 'admin') throw errors.conflict('Platform admins cannot be organization members.', 'SUPER_ADMIN_ONLY');
  const { membership, created } = await ensureMembership({
    organizationId,
    userId: user._id,
    role: body.role,
    status: 'INVITED',
    propertyIds,
    displayName: body.fullName,
    phone: body.phone,
    email: body.email || '',
    invitedBy: req.user._id,
  });
  if (!created) throw errors.conflict('This person is already a member of your organization.', 'ALREADY_MEMBER');
  audit(req, { action: 'member.invite', entityType: 'OrganizationUser', entityId: membership._id, summary: `${body.fullName} invited as ${body.role}` });
  notify({
    userIds: [user._id],
    organizationId,
    type: 'team',
    title: `You're invited to ${req.ctx.org.name}`,
    body: `${req.user.fullName} added you as ${ROLE_DEFS[body.role].name}. Open the PG app to accept.`,
    data: { route: 'invitations' },
    channels: ['inapp', 'push', 'sms'],
    smsText: `${req.ctx.org.name} invited you to join their team on Aabroo PG. Sign in with this number to accept.`,
  });
  return membership.toJSON();
});

const UpdateMemberDto = z.object({
  role: RoleEnum.optional(),
  propertyIds: z.array(id).max(100).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});

const loadMember = async (req, memberId) => {
  const m = await OrganizationUser.findOne({ _id: memberId, organizationId: req.ctx.orgId });
  if (!m) throw errors.notFound('Member');
  if (m.role === 'TENANT') throw errors.badRequest('Resident access is managed from the tenant profile.', 'TENANT_MEMBERSHIP');
  return m;
};

const assertNotLastOwner = async (organizationId, member) => {
  if (member.role !== 'OWNER') return;
  const owners = await OrganizationUser.countDocuments({ organizationId, role: 'OWNER', status: 'ACTIVE' });
  if (owners <= 1) throw errors.conflict('An organization needs at least one active owner.', 'LAST_OWNER');
};

r.put('/:id', { permission: 'org.members.manage', params: idParams, body: UpdateMemberDto, summary: 'Change role / scope / status' }, async req => {
  const member = await loadMember(req, req.valid.params.id);
  const body = req.valid.body;
  if (String(member.userId) === String(req.user._id) && (body.role || body.status)) {
    throw errors.forbidden('You cannot change your own role or status.', 'SELF_CHANGE');
  }
  if ((body.role && body.role !== 'OWNER') || body.status === 'DISABLED') await assertNotLastOwner(req.ctx.orgId, member);
  if ((body.role === 'OWNER' || member.role === 'OWNER') && req.ctx.role !== 'OWNER') {
    throw errors.forbidden('Only owners can change owner access.', 'PERMISSION_DENIED');
  }
  if (body.propertyIds) member.propertyIds = await assertProperties(req.ctx.orgId, body.propertyIds);
  if (body.role) member.role = body.role;
  if (body.status) member.status = member.status === 'INVITED' && body.status === 'ACTIVE' ? 'INVITED' : body.status;
  await member.save();
  audit(req, { action: 'member.update', entityType: 'OrganizationUser', entityId: member._id, changes: body });
  return member.toJSON();
});

r.delete('/:id', { permission: 'org.members.manage', params: idParams, summary: 'Remove a team member' }, async req => {
  const member = await loadMember(req, req.valid.params.id);
  if (String(member.userId) === String(req.user._id)) throw errors.forbidden('You cannot remove yourself.', 'SELF_CHANGE');
  await assertNotLastOwner(req.ctx.orgId, member);
  if (member.role === 'OWNER' && req.ctx.role !== 'OWNER') throw errors.forbidden('Only owners can remove owners.', 'PERMISSION_DENIED');
  await OrganizationUser.deleteOne({ _id: member._id, organizationId: req.ctx.orgId });
  // A staff profile that granted this access no longer has app access.
  await Staff.updateMany({ organizationId: req.ctx.orgId, membershipId: member._id }, { $set: { membershipId: null } });
  audit(req, { action: 'member.remove', entityType: 'OrganizationUser', entityId: member._id, summary: `${member.displayName} removed` });
  return { id: member._id, deleted: true };
});

// ---- Invitations (for the invited user; no org context needed) -------------

const inv = createRouter({ prefix: '/pg/me/invitations', tag: 'Team' });

inv.get('/', { auth: 'user', summary: 'My pending invitations' }, async req => {
  const rows = await unscoped(() => OrganizationUser.find({ userId: req.user._id, status: 'INVITED' }).lean());
  const orgs = await Organization.find({ _id: { $in: rows.map(m => m.organizationId) } }).select('name address').lean();
  const orgOf = new Map(orgs.map(o => [o._id, o]));
  return rows
    .filter(m => orgOf.has(m.organizationId))
    .map(m => ({
      id: m._id,
      organizationId: m.organizationId,
      organizationName: orgOf.get(m.organizationId).name,
      city: orgOf.get(m.organizationId).address && orgOf.get(m.organizationId).address.city,
      role: m.role,
      invitedAt: m.invitedAt,
    }));
});

const respond = accept => async req => {
  const membership = await unscoped(() =>
    OrganizationUser.findOne({ _id: req.valid.params.id, userId: req.user._id, status: 'INVITED' }),
  );
  if (!membership) throw errors.notFound('Invitation');
  if (accept) {
    await OrganizationUser.updateOne(
      { _id: membership._id, organizationId: membership.organizationId },
      { $set: { status: 'ACTIVE', joinedAt: new Date() } },
    );
  } else {
    await OrganizationUser.deleteOne({ _id: membership._id, organizationId: membership.organizationId });
  }
  audit(req, {
    organizationId: membership.organizationId,
    action: accept ? 'member.accept' : 'member.decline',
    entityType: 'OrganizationUser',
    entityId: membership._id,
  });
  return { id: membership._id, status: accept ? 'ACTIVE' : 'DECLINED', organizationId: membership.organizationId };
};

inv.post('/:id/accept', { auth: 'user', params: idParams, summary: 'Accept an invitation' }, respond(true));
inv.post('/:id/decline', { auth: 'user', params: idParams, summary: 'Decline an invitation' }, respond(false));

module.exports = { router: r.router, invitationsRouter: inv.router };
