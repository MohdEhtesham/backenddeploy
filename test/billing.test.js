// Rent, invoices, recurring generation, late fees, partial payments,
// advance credit and idempotent recording.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const D = require('../src/modules/core/dates');

let ctx;
const owner = (method, path, body, headers) => h.api(method, path, { token: ctx.owner.token, org: ctx.orgId, body, headers });

test.before(async () => {
  await h.startStack();
  ctx = await h.makeOrg({ name: 'Billing Nest', rooms: [{ roomNumber: '401', roomType: 'FOUR_SHARING', rentPerBed: 10000, depositPerBed: 0 }] });
  h.ok(await owner('PUT', '/pg/organization/settings', { lateFee: { type: 'PER_DAY', amount: 100, graceDays: 2, maxAmount: 1000 }, dueDays: 5 }));
});
test.after(h.stopStack);

const { generateDueInvoices, refreshOverdue } = require('../src/modules/pg/services/invoices');

test('monthly invoices are generated once per period (idempotent catch-up)', async () => {
  const today = D.todayIn('Asia/Kolkata');
  const joined = D.addMonths(D.startOfMonth(today), -2); // two full periods ago
  const t = await h.makeTenant(ctx, { fullName: 'Catch Up' });
  await h.checkIn(ctx, t.id, ctx.beds[0].id, { checkInDate: D.dayKey(joined), charges: [{ type: 'FOOD', amount: 2500 }] });

  const first = await generateDueInvoices(ctx.orgId);
  assert.equal(first.created, 2, 'the two missed months are billed');
  const second = await generateDueInvoices(ctx.orgId);
  assert.equal(second.created, 0, 'running again creates nothing');
  await Promise.all([generateDueInvoices(ctx.orgId), generateDueInvoices(ctx.orgId), generateDueInvoices(ctx.orgId)]);

  const rent = h.ok(await owner('GET', `/pg/invoices?tenantId=${t.id}&kind=RENT&pageSize=50`)).items;
  assert.equal(rent.length, 3, 'first stay invoice + 2 generated');
  assert.equal(new Set(rent.map(i => i.periodKey)).size, 3, 'one invoice per period');
  const full = rent.find(i => i.periodKey === D.dayKey(today).slice(0, 7));
  assert.deepEqual(full.lines.map(l => [l.type, l.amount]), [['RENT', 10000], ['FOOD', 2500]]);
  assert.equal(full.total, 12500);
  ctx.catchUp = t;
});

test('overdue status and per-day late fee (capped) accrue after grace', async () => {
  const t = ctx.catchUp;
  const now = new Date();
  await refreshOverdue(ctx.orgId, { now });
  const invoices = h.ok(await owner('GET', `/pg/invoices?tenantId=${t.id}&status=OVERDUE&pageSize=50`)).items;
  assert.ok(invoices.length >= 2, 'the older invoices are overdue');
  const oldest = invoices.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0];
  const fee = oldest.lines.find(l => l.type === 'LATE_FEE');
  assert.ok(fee && fee.amount > 0 && fee.amount <= 1000);
  // Re-running on the same day does not stack fees.
  await refreshOverdue(ctx.orgId, { now });
  const again = h.ok(await owner('GET', `/pg/invoices/${oldest.id}`));
  assert.equal(again.lines.filter(l => l.type === 'LATE_FEE').length, 1);
  assert.equal(again.lines.find(l => l.type === 'LATE_FEE').amount, fee.amount);
  // Waiver removes it and stops future accrual.
  const waived = h.ok(await owner('POST', `/pg/invoices/${oldest.id}/waive-late-fee`));
  assert.ok(!waived.lines.some(l => l.type === 'LATE_FEE'));
  await refreshOverdue(ctx.orgId, { now: new Date(Date.now() + 5 * 86400000) });
  const still = h.ok(await owner('GET', `/pg/invoices/${oldest.id}`));
  assert.ok(!still.lines.some(l => l.type === 'LATE_FEE'));
});

test('partial payments, allocation oldest-first, and advance credit', async () => {
  const t = ctx.catchUp;
  const before = h.ok(await owner('GET', `/pg/invoices?tenantId=${t.id}&open=true&pageSize=50`));
  const due = before.totals.balance;
  assert.ok(due > 0);

  const partial = h.ok(await owner('POST', '/pg/payments', { tenantId: t.id, amount: 5000, method: 'CASH' }), 201);
  assert.equal(partial.status, 'SUCCEEDED');
  assert.match(partial.receiptNumber, /^RCPT-\d{4}-\d{5}$/);
  assert.equal(partial.allocations.length, 1);
  const firstInvoice = h.ok(await owner('GET', `/pg/invoices/${partial.allocations[0].invoiceId}`));
  assert.ok(['PARTIALLY_PAID', 'OVERDUE'].includes(firstInvoice.status));
  assert.equal(firstInvoice.amountPaid, 5000);

  // Pay everything + 3,000 extra → all invoices PAID, 3,000 becomes advance.
  const rest = Math.round((due - 5000 + 3000) * 100) / 100;
  const big = h.ok(await owner('POST', '/pg/payments', { tenantId: t.id, amount: rest, method: 'UPI', reference: 'UPI-XYZ' }), 201);
  assert.equal(big.unappliedAmount, 3000);
  const open = h.ok(await owner('GET', `/pg/invoices?tenantId=${t.id}&open=true`)).items;
  assert.equal(open.length, 0);
  const profile = h.ok(await owner('GET', `/pg/tenants/${t.id}`));
  assert.equal(profile.creditBalance, 3000);

  // Next invoice consumes the advance automatically.
  const adhoc = h.ok(await owner('POST', '/pg/invoices', { tenantId: t.id, lines: [{ type: 'ELECTRICITY', description: 'Meter 1200-1350', amount: 1200 }] }), 201);
  assert.equal(adhoc.amountPaid, 1200);
  assert.equal(adhoc.status, 'PAID');
  const after = h.ok(await owner('GET', `/pg/tenants/${t.id}`));
  assert.equal(after.creditBalance, 1800);

  const ledger = h.ok(await owner('GET', `/pg/tenants/${t.id}/ledger`));
  assert.equal(ledger.summary.outstanding, 0);
  assert.equal(ledger.entries.at(-1).balance, -1800, 'running balance shows the remaining advance');
});

test('Idempotency-Key makes payment recording safe to retry', async () => {
  const t = await h.makeTenant(ctx, { fullName: 'Retry Safe' });
  await h.checkIn(ctx, t.id, ctx.beds[1].id, { checkInDate: h.todayKey() });
  const key = 'desk-retry-0001';
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => owner('POST', '/pg/payments', { tenantId: t.id, amount: 2000, method: 'CASH' }, { 'Idempotency-Key': key })));
  const bodies = [a, b, c].map(r => h.ok(r, 201));
  assert.equal(new Set(bodies.map(p => p.id)).size, 1, 'same payment returned for every retry');
  const Payment = require('../src/modules/pg/models/Payment');
  assert.equal(await Payment.countDocuments({ organizationId: ctx.orgId, idempotencyKey: key }), 1);
});

test('invoice edits recalculate totals; paid amounts are protected', async () => {
  const t = await h.makeTenant(ctx, { fullName: 'Edit Case' });
  await h.checkIn(ctx, t.id, ctx.beds[2].id, { checkInDate: h.todayKey() });
  const inv = h.ok(await owner('POST', '/pg/invoices', { tenantId: t.id, lines: [{ type: 'OTHER', description: 'Laundry', amount: 800 }] }), 201);
  const edited = h.ok(await owner('PUT', `/pg/invoices/${inv.id}`, { lines: [{ type: 'OTHER', description: 'Laundry', amount: 800 }, { type: 'DISCOUNT', description: 'Goodwill', amount: -300 }] }));
  assert.equal(edited.total, 500);
  h.ok(await owner('POST', '/pg/payments', { tenantId: t.id, amount: 500, method: 'CASH', invoiceIds: [inv.id] }), 201);
  const tooLow = await owner('PUT', `/pg/invoices/${inv.id}`, { lines: [{ type: 'OTHER', amount: 100 }] });
  assert.equal(tooLow.status, 409);
  const cancel = await owner('POST', `/pg/invoices/${inv.id}/cancel`, { reason: 'mistake' });
  assert.equal(cancel.status, 409, 'invoices with payments cannot be cancelled');
});

test('rent changes apply to future invoices only', async () => {
  const t = ctx.catchUp;
  const profile = h.ok(await owner('GET', `/pg/tenants/${t.id}`));
  const rent = h.ok(await owner('PUT', `/pg/rents/${profile.stay.rent.id}`, { monthlyRent: 11000, discount: { type: 'PERCENT', value: 10, label: 'Loyalty' } }));
  assert.equal(rent.monthlyRent, 11000);
  const Rent = require('../src/modules/pg/models/Rent');
  const doc = await Rent.findOne({ organizationId: ctx.orgId, _id: rent.id });
  const future = new Date(doc.nextBillingDate.getTime() + 86400000);
  const countFor = async () => h.ok(await owner('GET', `/pg/invoices?tenantId=${t.id}&kind=RENT&pageSize=1`)).total;
  const before = await countFor();
  const r = await generateDueInvoices(ctx.orgId, { now: future });
  assert.ok(r.created >= 1, 'every stay due by then is billed');
  assert.equal(await countFor(), before + 1, 'this stay gets exactly one new invoice');
  const latest = h.ok(await owner('GET', `/pg/invoices?tenantId=${t.id}&kind=RENT&sort=-issueDate&pageSize=1`)).items[0];
  assert.deepEqual(latest.lines.map(l => [l.type, l.amount]), [['RENT', 11000], ['FOOD', 2500], ['DISCOUNT', -1100]]);
});

test('reports: collection, revenue (json + csv), overdue aging', async () => {
  const revenue = h.ok(await owner('GET', '/pg/reports/revenue'));
  assert.ok(revenue.summary.received > 0);
  assert.ok(revenue.table.rows.length >= 1);
  const csv = await fetch(`${h.state.baseUrl}/api/pg/reports/revenue?format=csv`, { headers: { Authorization: `Bearer ${ctx.owner.token}`, 'X-Org-Id': ctx.orgId } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.match(text, /Month,Received,Rent/);
  const collection = h.ok(await owner('GET', '/pg/reports/rent-collection'));
  assert.ok(collection.summary.invoiced >= collection.summary.collected);
  const aging = h.ok(await owner('GET', '/pg/reports/overdue'));
  assert.ok('buckets' in aging.summary);
  const history = h.ok(await owner('GET', '/pg/reports/payments'));
  assert.ok(history.table.rows.length >= 3);
});
