// Structure → check-in → bed allocation → transfer → check-out settlement.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const D = require('../src/modules/core/dates');

let ctx;

test.before(async () => {
  await h.startStack();
  ctx = await h.makeOrg({
    name: 'Stay Flow PG',
    rooms: [
      { roomNumber: '301', roomType: 'SINGLE', rentPerBed: 12000, depositPerBed: 24000 },
      { roomNumber: '302', roomType: 'FOUR_SHARING', rentPerBed: 6000, depositPerBed: 6000 },
      { roomNumber: '303', roomType: 'CUSTOM', capacity: 5, rentPerBed: 5000 },
    ],
  });
});
test.after(h.stopStack);

const owner = (method, path, body) => h.api(method, path, { token: ctx.owner.token, org: ctx.orgId, body });

test('rooms create their beds; types imply capacity', async () => {
  const [single, four, custom] = ctx.rooms;
  assert.equal(single.beds.length, 1);
  assert.equal(four.beds.length, 4);
  assert.deepEqual(four.beds.map(b => b.label), ['A', 'B', 'C', 'D']);
  assert.equal(custom.beds.length, 5);
  const bad = await owner('POST', '/pg/rooms', { propertyId: ctx.property.id, buildingId: ctx.building.id, floorId: ctx.floor.id, roomNumber: '399', roomType: 'DOUBLE', capacity: 3, rentPerBed: 1 });
  assert.equal(bad.status, 400);
  const dup = await owner('POST', '/pg/rooms', { propertyId: ctx.property.id, buildingId: ctx.building.id, floorId: ctx.floor.id, roomNumber: '301', roomType: 'SINGLE', rentPerBed: 1 });
  assert.equal(dup.status, 409, 'room numbers are unique per property');
  const detail = h.ok(await owner('GET', `/pg/properties/${ctx.property.id}`));
  assert.equal(detail.occupancy.totalBeds, 10);
  assert.equal(detail.buildings[0].floors[0].rooms.length, 3);
});

test('check-in: bed occupied, invoices (deposit + prorated rent), agreement, app access', async () => {
  const tenant = await h.makeTenant(ctx, { fullName: 'Priya Nair' });
  const joining = D.dayKey(D.addDays(D.startOfMonth(D.todayIn('Asia/Kolkata')), 9)); // the 10th
  const res = await h.checkIn(ctx, tenant.id, ctx.rooms[0].beds[0].id, {
    checkInDate: joining,
    agreement: { lockInMonths: 3, noticePeriodDays: 30 },
    collect: { amount: 24000, method: 'UPI', reference: 'UPI123' },
  });
  assert.equal(res.tenant.status, 'ACTIVE');
  assert.equal(res.invoiceIds.length, 2);

  const bed = h.ok(await owner('GET', `/pg/beds/${ctx.rooms[0].beds[0].id}`));
  assert.equal(bed.status, 'OCCUPIED');
  assert.equal(bed.tenant.id, tenant.id);
  assert.equal(bed.history.length, 1);

  const invoices = h.ok(await owner('GET', `/pg/invoices?tenantId=${tenant.id}`)).items;
  const deposit = invoices.find(i => i.kind === 'DEPOSIT');
  const rent = invoices.find(i => i.kind === 'RENT');
  assert.equal(deposit.total, 24000);
  assert.equal(deposit.status, 'PAID', 'desk collection settled the deposit first');
  const p = require('../src/modules/pg/services/billing').firstPeriod(joining, 1);
  assert.equal(rent.total, Math.round(((12000 * p.chargedDays) / p.fullDays) * 100) / 100);
  assert.equal(rent.status === 'PENDING' || rent.status === 'OVERDUE', true);

  const t = h.ok(await owner('GET', `/pg/tenants/${tenant.id}`));
  assert.equal(t.depositHeld, 24000);
  assert.equal(t.stay.room.roomNumber, '301');
  assert.equal(t.stay.agreement.lockInMonths, 3);

  // The resident can sign in with OTP and sees their stay.
  const resident = await h.otpLogin(tenant.phone);
  const ctxRes = h.ok(await h.api('GET', '/pg/me/context', { token: resident.token }));
  assert.equal(ctxRes.active.role, 'TENANT');
  const stay = h.ok(await h.api('GET', '/pg/me/stay', { token: resident.token }));
  assert.equal(stay.room.roomNumber, '301');
  const accepted = h.ok(await h.api('POST', '/pg/me/agreement/accept', { token: resident.token }));
  assert.ok(accepted.acceptedAt);
  ctx.priya = { tenant, resident };
});

test('a bed can never be double allocated — even under concurrency', async () => {
  const bedId = ctx.rooms[1].beds[0].id;
  const tenants = await Promise.all(Array.from({ length: 6 }, (_, i) => h.makeTenant(ctx, { fullName: `Racer ${i}` })));
  const results = await Promise.all(
    tenants.map(t => owner('POST', '/pg/checkins', { tenantId: t.id, bedId, checkInDate: h.todayKey() })),
  );
  const winners = results.filter(r => r.status === 201);
  const losers = results.filter(r => r.status !== 201);
  assert.equal(winners.length, 1, `exactly one check-in may succeed: ${results.map(r => r.status).join(',')}`);
  assert.ok(losers.every(r => r.status === 409), losers.map(r => r.body.code).join(','));
  const BedAllocation = require('../src/modules/pg/models/BedAllocation');
  assert.equal(await BedAllocation.countDocuments({ organizationId: ctx.orgId, bedId, status: 'ACTIVE' }), 1);
  // Losing tenants stay prospects with nothing billed.
  const loserTenantIds = tenants.filter((_, i) => results[i].status !== 201).map(t => t.id);
  const RentInvoice = require('../src/modules/pg/models/RentInvoice');
  assert.equal(await RentInvoice.countDocuments({ organizationId: ctx.orgId, tenantId: { $in: loserTenantIds } }), 0);
  ctx.racerWinner = tenants[results.findIndex(r => r.status === 201)];
});

test('a tenant cannot hold two beds; blocked beds cannot be taken', async () => {
  const again = await owner('POST', '/pg/checkins', { tenantId: ctx.priya.tenant.id, bedId: ctx.rooms[1].beds[1].id });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'TENANT_ALREADY_CHECKED_IN');
  h.ok(await owner('POST', `/pg/beds/${ctx.rooms[1].beds[2].id}/status`, { status: 'MAINTENANCE', note: 'Leaking roof' }));
  const t = await h.makeTenant(ctx);
  const res = await owner('POST', '/pg/checkins', { tenantId: t.id, bedId: ctx.rooms[1].beds[2].id });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'BED_NOT_AVAILABLE');
  const occupied = await owner('POST', `/pg/beds/${ctx.rooms[0].beds[0].id}/status`, { status: 'BLOCKED' });
  assert.equal(occupied.status, 409, 'occupied beds cannot be blocked');
});

test('reservation holds a bed for one tenant only', async () => {
  const reserved = await h.makeTenant(ctx, { fullName: 'Reserved Guest' });
  const intruder = await h.makeTenant(ctx, { fullName: 'Intruder' });
  const bedId = ctx.rooms[2].beds[0].id;
  h.ok(await owner('POST', `/pg/beds/${bedId}/status`, { status: 'RESERVED', reservedForTenantId: reserved.id }));
  assert.equal((await owner('POST', '/pg/checkins', { tenantId: intruder.id, bedId })).status, 409);
  h.ok(await owner('POST', '/pg/checkins', { tenantId: reserved.id, bedId, checkInDate: h.todayKey() }), 201);
});

test('transfer moves the stay and keeps occupancy history', async () => {
  const winner = ctx.racerWinner;
  const from = ctx.rooms[1].beds[0].id;
  const to = ctx.rooms[2].beds[1].id;
  const moved = h.ok(await owner('POST', `/pg/tenants/${winner.id}/transfer`, { bedId: to, monthlyRent: 5500 }));
  assert.equal(moved.current.bedId, to);
  assert.equal(moved.monthlyRent, 5500);
  assert.equal(h.ok(await owner('GET', `/pg/beds/${from}`)).status, 'AVAILABLE');
  const target = h.ok(await owner('GET', `/pg/beds/${to}`));
  assert.equal(target.status, 'OCCUPIED');
  const history = h.ok(await owner('GET', `/pg/beds/${from}`)).history;
  assert.equal(history[0].endReason, 'TRANSFER');
});

test('notice → checkout: settlement, deposit adjustment, refund, bed released', async () => {
  const { tenant } = ctx.priya;
  const notice = h.ok(await owner('POST', `/pg/tenants/${tenant.id}/notice`, {}));
  assert.equal(notice.status, 'NOTICE');

  const checkoutDate = h.todayKey();
  const body = { tenantId: tenant.id, checkoutDate, electricity: 600, damages: [{ description: 'Mirror', amount: 400 }], waiveNoticeShortfall: true };
  const preview = h.ok(await owner('POST', '/pg/checkouts/preview', body));
  assert.equal(preview.depositHeld, 24000);
  assert.ok(preview.totalDues >= 1000);
  assert.equal(preview.refundTotal, Math.round((24000 - preview.depositApplied) * 100) / 100);

  const done = h.ok(await owner('POST', '/pg/checkouts', body), 201);
  assert.equal(done.tenant.status, 'CHECKED_OUT');
  assert.equal(done.checkOut.refundTotal, preview.refundTotal);
  assert.equal(done.checkOut.amountDue, 0);

  const bed = h.ok(await owner('GET', `/pg/beds/${ctx.rooms[0].beds[0].id}`));
  assert.equal(bed.status, 'AVAILABLE', 'bed released automatically');
  assert.equal(bed.history[0].endReason, 'CHECKOUT');

  const refunds = h.ok(await owner('GET', `/pg/refunds?tenantId=${tenant.id}`)).items;
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].type, 'DEPOSIT_REFUND');
  assert.equal(refunds[0].amount, preview.refundTotal);
  const processed = h.ok(await owner('POST', `/pg/refunds/${refunds[0].id}/process`, { method: 'BANK_TRANSFER', reference: 'NEFT001' }));
  assert.equal(processed.status, 'PROCESSED');

  const open = h.ok(await owner('GET', `/pg/invoices?tenantId=${tenant.id}&open=true`)).items;
  assert.equal(open.length, 0, 'all dues settled from the deposit');
  const again = await owner('POST', '/pg/checkouts', body);
  assert.equal(again.status, 409, 'cannot check out twice');

  // Checked-out tenant can check in again later (returning resident).
  const back = h.ok(await owner('POST', '/pg/checkins', { tenantId: tenant.id, bedId: ctx.rooms[0].beds[0].id, checkInDate: h.todayKey() }), 201);
  assert.equal(back.tenant.status, 'ACTIVE');
});

test('checkout with dues larger than the deposit leaves an amount due', async () => {
  const t = await h.makeTenant(ctx, { fullName: 'Short Deposit' });
  await h.checkIn(ctx, t.id, ctx.rooms[2].beds[2].id, { checkInDate: h.todayKey(), depositAmount: 1000, collect: { amount: 1000, method: 'CASH' } });
  const done = h.ok(
    await owner('POST', '/pg/checkouts', { tenantId: t.id, checkoutDate: h.todayKey(), damages: [{ description: 'Door', amount: 9000 }], waiveNoticeShortfall: true }),
    201,
  );
  assert.ok(done.checkOut.amountDue > 0);
  assert.equal(done.checkOut.refundTotal, 0);
  const ledger = h.ok(await owner('GET', `/pg/tenants/${t.id}/ledger`));
  assert.ok(ledger.summary.outstanding > 0);
});

test('structure deletes are guarded while in use', async () => {
  const res = await owner('DELETE', `/pg/properties/${ctx.property.id}`);
  assert.equal(res.status, 409);
  const floorDelete = await owner('DELETE', `/pg/floors/${ctx.floor.id}`);
  assert.equal(floorDelete.status, 409);
});
