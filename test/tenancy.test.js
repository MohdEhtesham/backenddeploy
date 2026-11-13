// CRITICAL: Organization A must NEVER read, change or reference
// Organization B's data — through any endpoint, id, header or payload.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let A;
let B;

test.before(async () => {
  await h.startStack();
  A = await h.makeOrg({ name: 'Org A Stays', rooms: [{ roomNumber: 'A1', roomType: 'DOUBLE', rentPerBed: 8000, depositPerBed: 10000 }] });
  B = await h.makeOrg({ name: 'Org B Hostels', rooms: [{ roomNumber: 'B1', roomType: 'TRIPLE', rentPerBed: 7000, depositPerBed: 9000 }] });

  // Populate B with every kind of record.
  B.tenant = await h.makeTenant(B, { fullName: 'Bina B' });
  await h.checkIn(B, B.tenant.id, B.beds[0].id, { checkInDate: h.todayKey(), collect: { amount: 5000, method: 'CASH' } });
  B.invoices = h.ok(await h.api('GET', '/pg/invoices', { token: B.owner.token, org: B.orgId })).items;
  B.payments = h.ok(await h.api('GET', '/pg/payments', { token: B.owner.token, org: B.orgId })).items;
  B.complaint = h.ok(
    await h.api('POST', '/pg/complaints', {
      token: B.owner.token,
      org: B.orgId,
      body: { propertyId: B.property.id, tenantId: B.tenant.id, category: 'WIFI', title: 'No internet' },
    }),
    201,
  );
  const expCats = h.ok(await h.api('GET', '/pg/expense-categories?pageSize=50', { token: B.owner.token, org: B.orgId })).items;
  B.expense = h.ok(
    await h.api('POST', '/pg/expenses', { token: B.owner.token, org: B.orgId, body: { categoryId: expCats[0].id, amount: 1200, date: h.todayKey(), propertyId: B.property.id } }),
    201,
  );
  B.notice = h.ok(
    await h.api('POST', '/pg/notices', { token: B.owner.token, org: B.orgId, body: { title: 'Water cut', body: 'Tomorrow 10–12', audience: { type: 'ALL' } } }),
    201,
  );
  const form = new FormData();
  form.append('tenantId', B.tenant.id);
  form.append('type', 'ID_PROOF');
  form.append('file', new Blob([Buffer.from('%PDF-1.4\n% test document\n')], { type: 'application/pdf' }), 'id.pdf');
  B.document = h.ok(await h.api('POST', '/pg/documents', { token: B.owner.token, org: B.orgId, body: form }), 201);
});
test.after(h.stopStack);

const asA = (method, path, body) => h.api(method, path, { token: A.owner.token, org: A.orgId, body });

test('lists only ever contain the caller organization’s rows', async () => {
  const listPaths = [
    '/pg/properties',
    '/pg/buildings',
    '/pg/floors',
    '/pg/rooms',
    '/pg/beds',
    '/pg/tenants',
    '/pg/invoices',
    '/pg/payments',
    '/pg/complaints',
    '/pg/expenses',
    '/pg/notices',
    '/pg/documents',
    '/pg/checkins',
    '/pg/rents',
    '/pg/amenities?pageSize=100',
    '/pg/expense-categories?pageSize=100',
  ];
  const bIds = new Set([
    B.property.id,
    B.building.id,
    B.floor.id,
    ...B.rooms.map(r => r.id),
    ...B.beds.map(b => b.id),
    B.tenant.id,
    ...B.invoices.map(i => i.id),
    ...B.payments.map(p => p.id),
    B.complaint.id,
    B.expense.id,
    B.notice.id,
    B.document.id,
  ]);
  for (const path of listPaths) {
    const page = h.ok(await asA('GET', path));
    for (const item of page.items) {
      assert.equal(item.organizationId, A.orgId, `${path} leaked a row from another org`);
      assert.ok(!bIds.has(item.id), `${path} returned B's ${item.id}`);
    }
  }
});

test('B’s ids are 404 for A on every detail / mutation endpoint', async () => {
  const cases = [
    ['GET', `/pg/properties/${B.property.id}`],
    ['PUT', `/pg/properties/${B.property.id}`, { name: 'Hijacked' }],
    ['DELETE', `/pg/properties/${B.property.id}`],
    ['GET', `/pg/rooms/${B.rooms[0].id}`],
    ['PUT', `/pg/rooms/${B.rooms[0].id}`, { rentPerBed: 1 }],
    ['GET', `/pg/beds/${B.beds[1].id}`],
    ['POST', `/pg/beds/${B.beds[1].id}/status`, { status: 'BLOCKED' }],
    ['GET', `/pg/tenants/${B.tenant.id}`],
    ['PUT', `/pg/tenants/${B.tenant.id}`, { fullName: 'Hijacked' }],
    ['GET', `/pg/tenants/${B.tenant.id}/ledger`],
    ['POST', `/pg/tenants/${B.tenant.id}/notice`, {}],
    ['GET', `/pg/invoices/${B.invoices[0].id}`],
    ['POST', `/pg/invoices/${B.invoices[0].id}/cancel`, { reason: 'x' }],
    ['GET', `/pg/payments/${B.payments[0].id}`],
    ['GET', `/pg/payments/${B.payments[0].id}/receipt`],
    ['GET', `/pg/complaints/${B.complaint.id}`],
    ['POST', `/pg/complaints/${B.complaint.id}/status`, { status: 'CLOSED' }],
    ['GET', `/pg/expenses/${B.expense.id}`],
    ['DELETE', `/pg/expenses/${B.expense.id}`],
    ['GET', `/pg/notices/${B.notice.id}`],
    ['GET', `/pg/documents/${B.document.id}/url`],
    ['POST', `/pg/documents/${B.document.id}/verify`, {}],
  ];
  for (const [method, path, body] of cases) {
    const res = await asA(method, path, body);
    assert.equal(res.status, 404, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  }
  // …and nothing changed on B's side.
  const still = h.ok(await h.api('GET', `/pg/tenants/${B.tenant.id}`, { token: B.owner.token, org: B.orgId }));
  assert.equal(still.fullName, 'Bina B');
  assert.equal(still.status, 'ACTIVE');
});

test('A cannot plant references to B’s records inside A', async () => {
  const room = await asA('POST', '/pg/rooms', {
    propertyId: A.property.id,
    buildingId: A.building.id,
    floorId: B.floor.id,
    roomNumber: 'X1',
    roomType: 'SINGLE',
    rentPerBed: 5000,
  });
  assert.equal(room.status, 404);
  const floor = await asA('POST', '/pg/floors', { propertyId: B.property.id, buildingId: B.building.id, name: 'Sneaky', level: 5 });
  assert.equal(floor.status, 404);
  const aTenant = await h.makeTenant(A);
  const checkin = await asA('POST', '/pg/checkins', { tenantId: aTenant.id, bedId: B.beds[1].id });
  assert.equal(checkin.status, 404, 'A cannot check into B’s bed');
  const pay = await asA('POST', '/pg/payments', { tenantId: B.tenant.id, amount: 100, method: 'CASH' });
  assert.equal(pay.status, 404);
  const notice = await asA('POST', '/pg/notices', { title: 'x', body: 'y', audience: { type: 'TENANT', tenantIds: [B.tenant.id] } });
  assert.equal(notice.status, 404);
  const complaint = await asA('POST', '/pg/complaints', { propertyId: B.property.id, category: 'OTHER', title: 'x' });
  assert.equal(complaint.status, 404);
});

test('client-supplied organizationId in bodies is ignored', async () => {
  const created = h.ok(
    await asA('POST', '/pg/buildings', { propertyId: A.property.id, name: 'Block Z', organizationId: B.orgId }),
    201,
  );
  assert.equal(created.organizationId, A.orgId);
  const bBuildings = h.ok(await h.api('GET', '/pg/buildings', { token: B.owner.token, org: B.orgId })).items;
  assert.ok(!bBuildings.some(x => x.id === created.id));
});

test('X-Org-Id spoofing without membership is rejected', async () => {
  const res = await h.api('GET', '/pg/tenants', { token: A.owner.token, org: B.orgId });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NOT_A_MEMBER');
  const ctx = h.ok(await h.api('GET', '/pg/me/context', { token: A.owner.token, org: B.orgId }));
  assert.equal(ctx.active.organization.id, A.orgId, 'context never switches to a foreign org');
  assert.ok(!ctx.organizations.some(o => o.organizationId === B.orgId));
});

test('a resident of B only reaches their own records', async () => {
  const resident = await h.otpLogin(B.tenant.phone);
  const stay = h.ok(await h.api('GET', '/pg/me/stay', { token: resident.token, org: B.orgId }));
  assert.equal(stay.tenant.id, B.tenant.id);
  // Staff-side endpoints are closed to residents.
  for (const path of ['/pg/tenants', '/pg/payments', '/pg/invoices', '/pg/dashboard', '/pg/reports/revenue']) {
    const res = await h.api('GET', path, { token: resident.token, org: B.orgId });
    assert.equal(res.status, 403, `${path} should be forbidden to a resident`);
  }
  // Cross-org: the resident is not a member of A.
  assert.equal((await h.api('GET', '/pg/me/stay', { token: resident.token, org: A.orgId })).status, 403);
  // Another resident of B cannot open this resident's invoice.
  const other = await h.makeTenant(B, { fullName: 'Other Resident' });
  await h.checkIn(B, other.id, B.beds[1].id, { checkInDate: h.todayKey() });
  const otherAuth = await h.otpLogin(other.phone);
  const res = await h.api('GET', `/pg/me/invoices/${B.invoices[0].id}`, { token: otherAuth.token, org: B.orgId });
  assert.equal(res.status, 404);
});

test('database guard rejects any unscoped query on tenant data', async () => {
  const Tenant = require('../src/modules/pg/models/Tenant');
  const RentInvoice = require('../src/modules/pg/models/RentInvoice');
  await assert.rejects(() => Tenant.find({}), e => e.code === 'TENANT_GUARD');
  await assert.rejects(() => Tenant.findById(B.tenant.id), e => e.code === 'TENANT_GUARD');
  await assert.rejects(() => RentInvoice.updateMany({ status: 'PENDING' }, { status: 'PAID' }), e => e.code === 'TENANT_GUARD');
  await assert.rejects(() => RentInvoice.aggregate([{ $match: {} }]), e => e.code === 'TENANT_GUARD');
  await assert.rejects(() => Tenant.find({ organizationId: { $in: [A.orgId, B.orgId] } }), e => e.code === 'TENANT_GUARD');
  const scoped = await Tenant.find({ organizationId: A.orgId }).lean();
  assert.ok(scoped.every(t => t.organizationId === A.orgId));
});

test('reports and dashboards aggregate only the caller organization', async () => {
  const dash = h.ok(await asA('GET', '/pg/dashboard'));
  assert.equal(dash.totalBeds, A.beds.length);
  assert.equal(dash.occupiedBeds, 0);
  assert.equal(dash.rentCollected, 0, 'B’s cash payment must not appear');
  const revenue = h.ok(await asA('GET', '/pg/reports/revenue'));
  assert.equal(revenue.summary.received, 0);
  const occ = h.ok(await asA('GET', '/pg/reports/occupancy'));
  assert.ok(occ.table.rows.every(r => r.propertyId === A.property.id));
});

test('notifications stay inside the organization', async () => {
  await h.flushNotifications();
  const Notification = require('../src/models/Notification');
  const leaked = await Notification.countDocuments({ organizationId: B.orgId, userId: A.owner.user.id });
  assert.equal(leaked, 0);
  const inbox = h.ok(await asA('GET', '/pg/notifications'));
  assert.ok(inbox.items.every(n => !/Bina|Water cut/.test(`${n.title} ${n.body}`)));
});
