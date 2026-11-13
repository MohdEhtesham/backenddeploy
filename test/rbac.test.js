const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;
let second;
const members = {};

test.before(async () => {
  await h.startStack();
  ctx = await h.makeOrg({ name: 'RBAC Residency', rooms: [{ roomNumber: '201', roomType: 'DOUBLE', rentPerBed: 9000 }] });
  second = h.ok(
    await h.api('POST', '/pg/properties', {
      token: ctx.owner.token,
      org: ctx.orgId,
      body: { name: 'Second Site', propertyType: 'HOSTEL', genderType: 'FEMALE', address: { city: 'Pune', state: 'MH', pincode: '411002' } },
    }),
    201,
  );
  for (const role of ['PROPERTY_MANAGER', 'ACCOUNTANT', 'RECEPTIONIST', 'SECURITY', 'STAFF']) {
    members[role] = await h.addMember(ctx, role);
  }
  members.SCOPED_MANAGER = await h.addMember(ctx, 'PROPERTY_MANAGER', { propertyIds: [second.id] });
});
test.after(h.stopStack);

const as = (who, method, path, body) => h.api(method, path, { token: members[who].token, org: ctx.orgId, body });

test('context reports the server-computed role and permissions', async () => {
  const c = h.ok(await h.api('GET', '/pg/me/context', { token: members.SECURITY.token }));
  assert.equal(c.active.role, 'SECURITY');
  assert.ok(c.active.permissions.includes('visitor.approve'));
  assert.ok(!c.active.permissions.includes('payment.read'));
});

test('granular permissions per role', async () => {
  const expectations = [
    ['STAFF', 'POST', '/pg/properties', { name: 'x', propertyType: 'PG', genderType: 'UNISEX', address: { city: 'a', state: 'b', pincode: '411001' } }, 403],
    ['STAFF', 'GET', '/pg/tenants', undefined, 403],
    ['STAFF', 'GET', '/pg/payments', undefined, 403],
    ['SECURITY', 'GET', '/pg/payments', undefined, 403],
    ['SECURITY', 'GET', '/pg/visitors', undefined, 200],
    ['SECURITY', 'POST', '/pg/checkins', { tenantId: '00000000-0000-4000-8000-000000000000', bedId: '00000000-0000-4000-8000-000000000000' }, 403],
    ['ACCOUNTANT', 'GET', '/pg/payments', undefined, 200],
    ['ACCOUNTANT', 'GET', '/pg/reports/revenue', undefined, 200],
    ['ACCOUNTANT', 'POST', '/pg/checkins', { tenantId: '00000000-0000-4000-8000-000000000000', bedId: '00000000-0000-4000-8000-000000000000' }, 403],
    ['RECEPTIONIST', 'GET', '/pg/tenants', undefined, 200],
    ['RECEPTIONIST', 'DELETE', `/pg/properties/${second.id}`, undefined, 403],
    ['PROPERTY_MANAGER', 'POST', '/pg/subscription/checkout', { planCode: 'STARTER' }, 403],
    ['PROPERTY_MANAGER', 'GET', '/pg/organization/audit-logs', undefined, 403],
    ['PROPERTY_MANAGER', 'POST', '/pg/users/invite', { phone: h.nextPhone(), fullName: 'Nope', role: 'STAFF' }, 403],
  ];
  for (const [who, method, path, body, status] of expectations) {
    const res = await as(who, method, path, body);
    assert.equal(res.status, status, `${who} ${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  }
});

test('property-scoped managers only see their properties', async () => {
  const list = h.ok(await as('SCOPED_MANAGER', 'GET', '/pg/properties')).items;
  assert.deepEqual(list.map(p => p.id), [second.id]);
  assert.equal((await as('SCOPED_MANAGER', 'GET', `/pg/properties/${ctx.property.id}`)).status, 404);
  assert.equal((await as('SCOPED_MANAGER', 'GET', `/pg/rooms/${ctx.rooms[0].id}`)).status, 404);
  const tenant = await h.makeTenant(ctx);
  await h.checkIn(ctx, tenant.id, ctx.beds[0].id, { checkInDate: h.todayKey() });
  const tenants = h.ok(await as('SCOPED_MANAGER', 'GET', '/pg/tenants?status=ACTIVE')).items;
  assert.ok(!tenants.some(t => t.id === tenant.id));
});

test('staff only see and act on work assigned to them', async () => {
  const staffRecord = h.ok(
    await h.api('POST', '/pg/staff', { token: ctx.owner.token, org: ctx.orgId, body: { fullName: 'Ravi Electrician', phone: h.nextPhone(), jobRole: 'ELECTRICIAN', department: 'MAINTENANCE' } }),
    201,
  );
  // Link the STAFF member's login to this staff record.
  const OrganizationUser = require('../src/modules/saas/models/OrganizationUser');
  await OrganizationUser.updateOne({ organizationId: ctx.orgId, userId: members.STAFF.user.id }, { $set: { staffId: staffRecord.id } });

  const mine = h.ok(await h.api('POST', '/pg/complaints', { token: ctx.owner.token, org: ctx.orgId, body: { propertyId: ctx.property.id, category: 'ELECTRICITY', title: 'Fan not working' } }), 201);
  const other = h.ok(await h.api('POST', '/pg/complaints', { token: ctx.owner.token, org: ctx.orgId, body: { propertyId: ctx.property.id, category: 'WIFI', title: 'Router down' } }), 201);
  h.ok(await h.api('POST', `/pg/complaints/${mine.id}/assign`, { token: ctx.owner.token, org: ctx.orgId, body: { staffId: staffRecord.id } }));

  const visible = h.ok(await as('STAFF', 'GET', '/pg/complaints')).items.map(c => c.id);
  assert.deepEqual(visible, [mine.id]);
  assert.equal((await as('STAFF', 'GET', `/pg/complaints/${other.id}`)).status, 404);
  h.ok(await as('STAFF', 'POST', `/pg/complaints/${mine.id}/status`, { status: 'IN_PROGRESS' }));
  const closeAttempt = await as('STAFF', 'POST', `/pg/complaints/${mine.id}/status`, { status: 'CLOSED' });
  assert.equal(closeAttempt.status, 403);
  const work = h.ok(await as('STAFF', 'GET', '/pg/work'));
  assert.equal(work.complaints.length, 1);
});

test('roles cannot be escalated from the client', async () => {
  // Unknown / forbidden fields in bodies are stripped by the DTOs.
  const res = await as('RECEPTIONIST', 'PUT', `/pg/tenants/${(await h.makeTenant(ctx)).id}`, { role: 'OWNER', permissions: ['*'], fullName: 'Renamed' });
  assert.equal(h.ok(res).fullName, 'Renamed');
  const c = h.ok(await h.api('GET', '/pg/me/context', { token: members.RECEPTIONIST.token }));
  assert.equal(c.active.role, 'RECEPTIONIST');
  // A manager cannot change their own role or grant owner.
  const list = h.ok(await h.api('GET', '/pg/users', { token: ctx.owner.token, org: ctx.orgId })).items;
  const manager = list.find(m => m.role === 'PROPERTY_MANAGER' && String(m.userId) === String(members.PROPERTY_MANAGER.user.id));
  assert.equal((await as('PROPERTY_MANAGER', 'PUT', `/pg/users/${manager.id}`, { role: 'OWNER' })).status, 403);
});

test('owners keep at least one owner and cannot demote themselves', async () => {
  const list = h.ok(await h.api('GET', '/pg/users', { token: ctx.owner.token, org: ctx.orgId })).items;
  const ownerRow = list.find(m => m.role === 'OWNER');
  const self = await h.api('PUT', `/pg/users/${ownerRow.id}`, { token: ctx.owner.token, org: ctx.orgId, body: { role: 'STAFF' } });
  assert.equal(self.status, 403);
});

test('disabled members lose access immediately', async () => {
  const list = h.ok(await h.api('GET', '/pg/users', { token: ctx.owner.token, org: ctx.orgId })).items;
  const acct = list.find(m => String(m.userId) === String(members.ACCOUNTANT.user.id));
  h.ok(await h.api('PUT', `/pg/users/${acct.id}`, { token: ctx.owner.token, org: ctx.orgId, body: { status: 'DISABLED' } }));
  const res = await as('ACCOUNTANT', 'GET', '/pg/payments');
  assert.equal(res.status, 403);
});
