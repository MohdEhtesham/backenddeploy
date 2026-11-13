// Complaints, maintenance, staff & attendance, visitors, notices, mess,
// expenses, documents, dashboard and notifications.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;
let resident;
let tenant;
let neighbour;
let security;
const owner = (method, path, body) => h.api(method, path, { token: ctx.owner.token, org: ctx.orgId, body });
const me = (method, path, body) => h.api(method, path, { token: resident.token, org: ctx.orgId, body });

test.before(async () => {
  await h.startStack();
  ctx = await h.makeOrg({ name: 'Ops Residency', rooms: [{ roomNumber: '601', roomType: 'DOUBLE', rentPerBed: 8000 }, { roomNumber: '602', roomType: 'DOUBLE', rentPerBed: 8000 }] });
  h.ok(await owner('PUT', `/pg/properties/${ctx.property.id}`, { messEnabled: true, messChargeMonthly: 3000 }));
  tenant = await h.makeTenant(ctx, { fullName: 'Meera Iyer', foodPreference: 'VEG', messOptIn: true });
  neighbour = await h.makeTenant(ctx, { fullName: 'Karan Mehta' });
  await h.checkIn(ctx, tenant.id, ctx.rooms[0].beds[0].id, { checkInDate: h.todayKey() });
  await h.checkIn(ctx, neighbour.id, ctx.rooms[1].beds[0].id, { checkInDate: h.todayKey() });
  resident = await h.otpLogin(tenant.phone);
  security = await h.addMember(ctx, 'SECURITY');
});
test.after(h.stopStack);

test('mess enrolment adds the monthly food charge to rent invoices', async () => {
  const inv = h.ok(await owner('GET', `/pg/invoices?tenantId=${tenant.id}&kind=RENT`)).items[0];
  assert.ok(inv.lines.some(l => l.type === 'FOOD'));
});

test('complaint lifecycle: tenant → assign → staff → resolve → rate & close', async () => {
  const staff = h.ok(await owner('POST', '/pg/staff', { fullName: 'Suresh Plumber', phone: h.nextPhone(), jobRole: 'PLUMBER', department: 'MAINTENANCE', propertyIds: [ctx.property.id] }), 201);
  const access = h.ok(await owner('POST', `/pg/staff/${staff.id}/app-access`, { role: 'STAFF' }), 201);
  assert.equal(access.status, 'INVITED');
  const staffAuth = await h.otpLogin(staff.phone);
  const inv = h.ok(await h.api('GET', '/pg/me/invitations', { token: staffAuth.token }));
  h.ok(await h.api('POST', `/pg/me/invitations/${inv[0].id}/accept`, { token: staffAuth.token }));

  const complaint = h.ok(await me('POST', '/pg/me/complaints', { category: 'PLUMBING', title: 'Tap leaking', description: 'Bathroom tap', priority: 'HIGH' }), 201);
  assert.equal(complaint.status, 'OPEN');
  assert.equal(complaint.propertyId, ctx.property.id);

  // Photo evidence (private, signed URL).
  const form = new FormData();
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8FFFF3F0005FE02FEA7D6A5A10000000049454E44AE426082', 'hex');
  form.append('file', new Blob([png], { type: 'image/png' }), 'leak.png');
  const withPhoto = h.ok(await h.api('POST', `/pg/me/complaints/${complaint.id}/images`, { token: resident.token, org: ctx.orgId, body: form }), 201);
  assert.equal(withPhoto.images.length, 1);
  const img = await fetch(withPhoto.images[0].url.replace('http://127.0.0.1', h.state.baseUrl));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  // A forged / tampered file link is refused.
  const forged = await fetch(`${withPhoto.images[0].url.replace('http://127.0.0.1', h.state.baseUrl)}x`);
  assert.equal(forged.status, 403);
  // Spoofed content type is rejected by content sniffing.
  const fake = new FormData();
  fake.append('file', new Blob([Buffer.from('not really a png')], { type: 'image/png' }), 'x.png');
  assert.equal((await h.api('POST', `/pg/me/complaints/${complaint.id}/images`, { token: resident.token, org: ctx.orgId, body: fake })).status, 400);

  // Every complaint response carries signed URLs only — never storage keys.
  const onlySignedUrls = doc =>
    doc.images.length === 1 && doc.images.every(i => i.key === undefined && i.storageDriver === undefined && typeof i.url === 'string');
  const assigned = h.ok(await owner('POST', `/pg/complaints/${complaint.id}/assign`, { staffId: staff.id }));
  assert.ok(onlySignedUrls(assigned), 'assign response hides storage keys');
  const work = h.ok(await h.api('GET', '/pg/work', { token: staffAuth.token, org: ctx.orgId }));
  assert.equal(work.complaints[0].id, complaint.id);
  h.ok(await h.api('POST', `/pg/complaints/${complaint.id}/status`, { token: staffAuth.token, org: ctx.orgId, body: { status: 'IN_PROGRESS' } }));
  const resolved = h.ok(await h.api('POST', `/pg/complaints/${complaint.id}/status`, { token: staffAuth.token, org: ctx.orgId, body: { status: 'RESOLVED', note: 'Washer replaced' } }));
  assert.ok(onlySignedUrls(resolved), 'status response hides storage keys');

  const rated = h.ok(await me('POST', `/pg/me/complaints/${complaint.id}/feedback`, { rating: 5, feedback: 'Quick fix' }));
  assert.equal(rated.status, 'CLOSED');
  assert.ok(onlySignedUrls(rated), 'resident responses hide storage keys');
  const detail = h.ok(await me('GET', `/pg/me/complaints/${complaint.id}`));
  assert.deepEqual(detail.history.map(x => x.status), ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
  assert.ok(detail.assignedAt && detail.inProgressAt && detail.resolvedAt && detail.closedAt);
  const invalid = await owner('POST', `/pg/complaints/${complaint.id}/status`, { status: 'IN_PROGRESS' });
  assert.equal(invalid.status, 409);
  ctx.staff = staff;
});

test('maintenance tasks: create, assign, resolve (resolves linked complaint)', async () => {
  const c = h.ok(await owner('POST', '/pg/complaints', { propertyId: ctx.property.id, roomId: ctx.rooms[0].id, category: 'AC', title: 'AC not cooling' }), 201);
  const task = h.ok(await owner('POST', `/pg/complaints/${c.id}/convert`, { estimatedCost: 1500 }), 201);
  assert.equal(task.complaintId, c.id);
  h.ok(await owner('POST', `/pg/maintenance/${task.id}/assign`, { staffId: ctx.staff.id }));
  h.ok(await owner('POST', `/pg/maintenance/${task.id}/status`, { status: 'IN_PROGRESS' }));
  const done = h.ok(await owner('POST', `/pg/maintenance/${task.id}/status`, { status: 'RESOLVED', actualCost: 1200, note: 'Gas refilled' }));
  assert.equal(done.status, 'RESOLVED');
  assert.equal(done.actualCost, 1200);
  const linked = h.ok(await owner('GET', `/pg/complaints/${c.id}`));
  assert.equal(linked.status, 'RESOLVED');
  const report = h.ok(await owner('GET', '/pg/reports/maintenance'));
  assert.equal(report.summary.actualCost, 1200);
});

test('staff attendance: bulk mark, no future dates, monthly summary', async () => {
  const today = h.todayKey();
  h.ok(await owner('POST', '/pg/attendance', { date: today, entries: [{ staffId: ctx.staff.id, status: 'PRESENT' }] }));
  h.ok(await owner('POST', '/pg/attendance', { date: today, entries: [{ staffId: ctx.staff.id, status: 'HALF_DAY' }] }));
  const sheet = h.ok(await owner('GET', `/pg/attendance?date=${today}`));
  assert.equal(sheet.rows.find(r => r.staffId === ctx.staff.id).status, 'HALF_DAY', 'upsert, not duplicate');
  const future = await owner('POST', '/pg/attendance', { date: '2999-01-01', entries: [{ staffId: ctx.staff.id, status: 'PRESENT' }] });
  assert.equal(future.status, 400);
  const month = h.ok(await owner('GET', `/pg/attendance/staff/${ctx.staff.id}?month=${today.slice(0, 7)}`));
  assert.equal(month.summary.HALF_DAY, 1);
  const StaffAttendance = require('../src/modules/pg/models/StaffAttendance');
  const row = await StaffAttendance.findOne({ organizationId: ctx.orgId, staffId: ctx.staff.id }).lean();
  assert.match(row._id, /^[0-9a-f-]{36}$/, 'upserted rows keep UUID ids');
});

test('visitors: tenant request → security approve → check-in → check-out', async () => {
  const req = h.ok(await me('POST', '/pg/me/visitors', { visitorName: 'Anita Iyer', visitorPhone: h.nextPhone(), purpose: 'Family visit', idType: 'AADHAAR', idNumber: '1234 5678 9012' }), 201);
  assert.equal(req.status, 'REQUESTED');
  assert.equal(req.idNumberMasked.slice(-4), '9012');
  assert.ok(!JSON.stringify(req).includes('1234 5678'), 'full ID number is never stored');
  const sec = (method, path, body) => h.api(method, path, { token: security.token, org: ctx.orgId, body });
  const verified = h.ok(await sec('GET', `/pg/visitors/verify/${req.passCode}`));
  assert.equal(verified.id, req.id);
  h.ok(await sec('POST', `/pg/visitors/${req.id}/approve`, {}));
  h.ok(await sec('POST', `/pg/visitors/${req.id}/checkin`, {}));
  const out = h.ok(await sec('POST', `/pg/visitors/${req.id}/checkout`, {}));
  assert.equal(out.status, 'CHECKED_OUT');
  const detail = h.ok(await sec('GET', `/pg/visitors/${req.id}`));
  assert.equal(detail.entries.length, 1);
  assert.ok(detail.entries[0].exitAt);
  assert.equal((await sec('POST', `/pg/visitors/${req.id}/checkin`, {})).status, 409);
  // Tenant can cancel only their own open requests.
  const other = h.ok(await me('POST', '/pg/me/visitors', { visitorName: 'Courier', visitorPhone: h.nextPhone() }), 201);
  h.ok(await me('POST', `/pg/me/visitors/${other.id}/cancel`));
});

test('notices target the right audience (floor / room / tenant) and notify', async () => {
  const roomNotice = h.ok(await owner('POST', '/pg/notices', { title: 'Room 601 pest control', body: 'Friday 11am', audience: { type: 'ROOM', roomIds: [ctx.rooms[0].id] } }), 201);
  assert.equal(roomNotice.recipientCount, 1);
  const all = h.ok(await owner('POST', '/pg/notices', { title: 'Diwali dinner', body: 'Terrace, 8pm', audience: { type: 'ALL' }, priority: 'IMPORTANT' }), 201);
  assert.equal(all.recipientCount, 2);
  const mine = h.ok(await me('GET', '/pg/me/notices')).items.map(n => n.id);
  assert.ok(mine.includes(roomNotice.id) && mine.includes(all.id));
  const neighbourAuth = await h.otpLogin(neighbour.phone);
  const theirs = h.ok(await h.api('GET', '/pg/me/notices', { token: neighbourAuth.token, org: ctx.orgId })).items.map(n => n.id);
  assert.ok(!theirs.includes(roomNotice.id) && theirs.includes(all.id));
  await h.flushNotifications();
  const inbox = h.ok(await me('GET', '/pg/notifications'));
  assert.ok(inbox.items.some(n => n.type === 'notice'));
  const count = h.ok(await me('GET', '/pg/notifications/unread-count'));
  assert.ok(count.count >= 1);
  h.ok(await me('POST', '/pg/notifications/read-all'));
  assert.equal(h.ok(await me('GET', '/pg/notifications/unread-count')).count, 0);
});

test('mess: weekly menu, tenant opt-out, kitchen headcount, served meals', async () => {
  for (let d = 0; d < 7; d += 1) {
    h.ok(await owner('PUT', '/pg/mess/menu', { propertyId: ctx.property.id, dayOfWeek: d, breakfast: { items: ['Poha', 'Tea'], time: '08:00' }, lunch: { items: ['Dal', 'Rice'] }, dinner: { items: ['Roti', 'Paneer'] } }));
  }
  const plan = h.ok(await me('GET', '/pg/me/mess'));
  assert.equal(plan.days.length, 7);
  assert.equal(plan.days[0].meals[0].items[0], 'Poha');
  const today = h.todayKey();
  h.ok(await me('POST', '/pg/me/mess/opt-out', { date: today, meal: 'DINNER' }));
  const summary = h.ok(await owner('GET', `/pg/mess/summary?propertyId=${ctx.property.id}&date=${today}`));
  assert.equal(summary.enrolled, 1);
  assert.equal(summary.meals.DINNER.expected, 0);
  assert.equal(summary.meals.LUNCH.expected, 1);
  assert.equal(summary.foodPreferences.VEG, 1);
  h.ok(await owner('POST', '/pg/mess/attendance', { date: today, meal: 'LUNCH', tenantIds: [tenant.id] }));
  const after = h.ok(await owner('GET', `/pg/mess/summary?propertyId=${ctx.property.id}&date=${today}`));
  assert.equal(after.meals.LUNCH.served, 1);
  const past = await me('POST', '/pg/me/mess/opt-out', { date: '2000-01-01', meal: 'LUNCH' });
  assert.equal(past.status, 409);
});

test('expenses: categories, monthly summary, private receipt, P&L', async () => {
  const cats = h.ok(await owner('GET', '/pg/expense-categories?pageSize=50')).items;
  assert.ok(['Electricity', 'Water', 'Salary', 'Maintenance', 'Food', 'Internet', 'Cleaning', 'Supplies', 'Other'].every(n => cats.some(c => c.name === n)));
  const electricity = cats.find(c => c.name === 'Electricity');
  const exp = h.ok(await owner('POST', '/pg/expenses', { categoryId: electricity.id, amount: 4200, date: h.todayKey(), vendor: 'MSEB', propertyId: ctx.property.id }), 201);
  assert.equal(exp.categoryName, 'Electricity');
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%PDF-1.4 bill')], { type: 'application/pdf' }), 'bill.pdf');
  h.ok(await h.api('POST', `/pg/expenses/${exp.id}/receipt`, { token: ctx.owner.token, org: ctx.orgId, body: form }));
  const signed = h.ok(await owner('GET', `/pg/expenses/${exp.id}/receipt`));
  assert.ok(signed.url && signed.expiresAt);
  const summary = h.ok(await owner('GET', `/pg/expenses/summary/monthly?month=${h.todayKey().slice(0, 7)}`));
  assert.equal(summary.total, 4200);
  const system = await owner('DELETE', `/pg/expense-categories/${electricity.id}`);
  assert.equal(system.status, 409);
  const pl = h.ok(await owner('GET', '/pg/reports/profit'));
  assert.equal(pl.summary.expenses, 4200);
});

test('KYC documents: upload, verify → tenant KYC verified, signed URL only', async () => {
  const form = new FormData();
  form.append('type', 'ID_PROOF');
  form.append('subType', 'AADHAAR');
  form.append('docNumber', '9999 8888 7777');
  form.append('file', new Blob([Buffer.from('%PDF-1.7 aadhaar')], { type: 'application/pdf' }), 'aadhaar.pdf');
  const doc = h.ok(await h.api('POST', '/pg/me/documents', { token: resident.token, org: ctx.orgId, body: form }), 201);
  assert.equal(doc.status, 'PENDING');
  assert.equal(doc.docNumberMasked.slice(-4), '7777');
  assert.equal(doc.fileKey, undefined, 'storage keys never leave the server');
  const verified = h.ok(await owner('POST', `/pg/documents/${doc.id}/verify`, {}));
  assert.equal(verified.kycStatus, 'VERIFIED');
  assert.equal(h.ok(await owner('GET', `/pg/tenants/${tenant.id}`)).kycStatus, 'VERIFIED');
  const url = h.ok(await me('GET', `/pg/me/documents/${doc.id}/url`));
  const file = await fetch(url.url.replace('http://127.0.0.1', h.state.baseUrl));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('cache-control'), 'private, no-store');
});

test('tenant self-service: profile update and notice', async () => {
  const updated = h.ok(await me('PUT', '/pg/me/profile', { occupation: 'Engineer', emergencyContacts: [{ name: 'Ravi Iyer', relation: 'Father', phone: h.nextPhone() }], status: 'CHECKED_OUT' }));
  assert.equal(updated.occupation, 'Engineer');
  assert.equal(updated.status, 'ACTIVE', 'status cannot be set by the tenant');
  const notice = h.ok(await me('POST', '/pg/me/notice', {}));
  assert.equal(notice.status, 'NOTICE');
  const dash = h.ok(await owner('GET', '/pg/dashboard'));
  assert.equal(dash.onNotice, 1);
});

test('owner dashboard figures', async () => {
  const dash = h.ok(await owner('GET', '/pg/dashboard'));
  assert.equal(dash.totalProperties, 1);
  assert.equal(dash.totalBeds, 4);
  assert.equal(dash.occupiedBeds, 2);
  assert.equal(dash.availableBeds, 2);
  assert.equal(dash.occupancyPct, 50);
  assert.equal(dash.todaysCheckIns, 2);
  assert.ok(dash.rentPending > 0);
  assert.equal(dash.expenses, 4200);
  assert.equal(dash.netRevenue, Math.round((dash.rentCollected - 4200) * 100) / 100);
  assert.ok(Array.isArray(dash.trend) && dash.trend.length >= 1);
  const tenantDash = await me('GET', '/pg/dashboard');
  assert.equal(tenantDash.status, 403);
});

test('push / SMS channels receive dispatched notifications', async () => {
  h.ok(await h.api('POST', '/devices', { token: resident.token, body: { token: `fcm-token-${'x'.repeat(40)}`, platform: 'android' } }));
  h.ok(await owner('POST', '/pg/notices', { title: 'Lift maintenance', body: 'Use stairs today', audience: { type: 'TENANT', tenantIds: [tenant.id] } }), 201);
  await h.flushNotifications();
  assert.ok(h.state.captured.push.some(([token, msg]) => token.startsWith('fcm-token-') && msg.title === 'Lift maintenance'));
});

test('attendance re-mark keeps recorded times; removing a member clears the staff app-access link', async () => {
  const today = h.todayKey();
  const checkInAt = new Date().toISOString();
  h.ok(await owner('POST', '/pg/attendance', { date: today, entries: [{ staffId: ctx.staff.id, status: 'PRESENT', checkInAt }] }));
  h.ok(await owner('POST', '/pg/attendance', { date: today, entries: [{ staffId: ctx.staff.id, status: 'HALF_DAY' }] }));
  const StaffAttendance = require('../src/modules/pg/models/StaffAttendance');
  const row = await StaffAttendance.findOne({ organizationId: ctx.orgId, staffId: ctx.staff.id, dateKey: today }).lean();
  assert.equal(row.status, 'HALF_DAY');
  assert.equal(new Date(row.checkInAt).toISOString(), checkInAt, 'omitted check-in time is kept');

  const linked = h.ok(await owner('GET', `/pg/staff/${ctx.staff.id}`));
  assert.ok(linked.membershipId, 'staff has app access');
  h.ok(await owner('DELETE', `/pg/users/${linked.membershipId}`));
  const unlinked = h.ok(await owner('GET', `/pg/staff/${ctx.staff.id}`));
  assert.equal(unlinked.membershipId, null);
});
