// Online payments: Mobile → Backend → Gateway → Webhook → verification →
// DB → receipt. The client can never mark a payment as paid.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;
let resident;
let tenant;
const owner = (method, path, body) => h.api(method, path, { token: ctx.owner.token, org: ctx.orgId, body });
const me = (method, path, body) => h.api(method, path, { token: resident.token, org: ctx.orgId, body });

test.before(async () => {
  await h.startStack();
  ctx = await h.makeOrg({ name: 'Online Pay PG', rooms: [{ roomNumber: '501', roomType: 'DOUBLE', rentPerBed: 7500, depositPerBed: 5000 }] });
  tenant = await h.makeTenant(ctx, { fullName: 'Online Payer' });
  await h.checkIn(ctx, tenant.id, ctx.beds[0].id, { checkInDate: h.todayKey() });
  resident = await h.otpLogin(tenant.phone);
});
test.after(h.stopStack);

const linkFor = paymentId => [...h.state.rzp.links.values()].find(l => l.reference_id === paymentId);

test('tenant starts a payment: amount is computed server-side from open invoices', async () => {
  const open = h.ok(await me('GET', '/pg/me/invoices?open=true')).items;
  const due = open.reduce((t, i) => t + i.balance, 0);
  const started = h.ok(await me('POST', '/pg/me/payments', { amount: 1, status: 'SUCCEEDED' }), 201);
  assert.equal(started.amount, due, 'client-sent amount/status are ignored');
  assert.match(started.checkoutUrl, /^https:\/\/rzp\.io\//);
  const link = linkFor(started.paymentId);
  assert.equal(link.amount, Math.round(due * 100), 'gateway charged in paise');

  const pending = h.ok(await me('GET', `/pg/me/payments/${started.paymentId}`));
  assert.equal(pending.status, 'PENDING');

  // Reusing the same checkout for the same order.
  const again = h.ok(await me('POST', '/pg/me/payments', {}), 201);
  assert.equal(again.paymentId, started.paymentId);
  ctx.first = { ...started, due };
});

test('no endpoint lets the client mark a payment as paid', async () => {
  const id = ctx.first.paymentId;
  for (const [method, path] of [
    ['PUT', `/pg/me/payments/${id}`],
    ['POST', `/pg/me/payments/${id}/confirm`],
    ['PUT', `/pg/payments/${id}`],
    ['POST', `/pg/payments/${id}/confirm`],
  ]) {
    const res = await h.api(method, path, { token: resident.token, org: ctx.orgId, body: { status: 'SUCCEEDED' } });
    assert.ok([403, 404].includes(res.status), `${method} ${path} → ${res.status}`);
  }
  const still = h.ok(await me('GET', `/pg/me/payments/${id}`));
  assert.equal(still.status, 'PENDING');
});

test('webhooks with a bad signature are rejected and change nothing', async () => {
  const link = linkFor(ctx.first.paymentId);
  const forged = { ...link, amount_paid: link.amount, status: 'paid' };
  const res = await h.deliverWebhook(h.paidEvent(forged, 'pay_forged'), { secret: 'wrong-secret' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_SIGNATURE');
  assert.equal(h.ok(await me('GET', `/pg/me/payments/${ctx.first.paymentId}`)).status, 'PENDING');
});

test('verified webhook confirms, allocates, issues a receipt — exactly once', async () => {
  const { link, paymentId: gatewayPaymentId } = h.state.rzp.pay(linkFor(ctx.first.paymentId).id);
  const event = h.paidEvent(link, gatewayPaymentId);
  const eventId = 'evt_paid_001';
  // Duplicate + concurrent deliveries of the same event, plus a second event id for the same payment.
  const deliveries = await Promise.all([
    h.deliverWebhook(event, { eventId }),
    h.deliverWebhook(event, { eventId }),
    h.deliverWebhook(event, { eventId: 'evt_paid_002' }),
  ]);
  deliveries.forEach(d => assert.equal(d.status, 200, JSON.stringify(d.body)));

  const paid = h.ok(await me('GET', `/pg/me/payments/${ctx.first.paymentId}`));
  assert.equal(paid.status, 'SUCCEEDED');
  assert.match(paid.receiptNumber, /^RCPT-/);
  assert.equal(paid.gateway.paymentId, gatewayPaymentId);
  const allocated = paid.allocations.reduce((t, a) => t + a.amount, 0);
  assert.equal(allocated, ctx.first.due, 'credited once, not three times');

  const open = h.ok(await me('GET', '/pg/me/invoices?open=true')).items;
  assert.equal(open.length, 0);
  const WebhookEvent = require('../src/modules/payments/WebhookEvent');
  assert.equal(await WebhookEvent.countDocuments({ eventId }), 1);

  const receipt = await fetch(`${h.state.baseUrl}/api/pg/me/payments/${ctx.first.paymentId}/receipt.html`, { headers: { Authorization: `Bearer ${resident.token}`, 'X-Org-Id': ctx.orgId } });
  assert.equal(receipt.status, 200);
  assert.match(await receipt.text(), /PAYMENT RECEIVED/);
  await h.flushNotifications();
  const Notification = require('../src/models/Notification');
  assert.ok(await Notification.exists({ userId: resident.user.id, type: 'payment_confirmation' }));
});

test('amount mismatch never credits the tenant', async () => {
  const adhoc = h.ok(await owner('POST', '/pg/invoices', { tenantId: tenant.id, lines: [{ type: 'OTHER', description: 'Gym', amount: 999 }] }), 201);
  const started = h.ok(await me('POST', '/pg/me/payments', { invoiceIds: [adhoc.id] }), 201);
  const { link, paymentId } = h.state.rzp.pay(linkFor(started.paymentId).id, 100); // paid ₹1 instead of ₹999
  h.ok(await h.deliverWebhook(h.paidEvent(link, paymentId)));
  const p = h.ok(await me('GET', `/pg/me/payments/${started.paymentId}`));
  assert.equal(p.status, 'FAILED');
  const inv = h.ok(await me('GET', `/pg/me/invoices/${adhoc.id}`));
  assert.equal(inv.amountPaid, 0);
});

test('without a webhook, polling reconciles server-to-server with the gateway', async () => {
  const adhoc = h.ok(await owner('POST', '/pg/invoices', { tenantId: tenant.id, lines: [{ type: 'OTHER', description: 'Parking', amount: 500 }] }), 201);
  const started = h.ok(await me('POST', '/pg/me/payments', { invoiceIds: [adhoc.id] }), 201);
  h.state.rzp.pay(linkFor(started.paymentId).id);
  const polled = h.ok(await me('GET', `/pg/me/payments/${started.paymentId}`));
  assert.equal(polled.status, 'SUCCEEDED');
  assert.equal(h.ok(await me('GET', `/pg/me/invoices/${adhoc.id}`)).status, 'PAID');
});

test('checkout return page verifies the redirect signature and deep-links back', async () => {
  const adhoc = h.ok(await owner('POST', '/pg/invoices', { tenantId: tenant.id, lines: [{ type: 'OTHER', description: 'Locker', amount: 300 }] }), 201);
  const started = h.ok(await me('POST', '/pg/me/payments', { invoiceIds: [adhoc.id] }), 201);
  const { link, paymentId } = h.state.rzp.pay(linkFor(started.paymentId).id);
  const crypto = require('crypto');
  const q = {
    razorpay_payment_id: paymentId,
    razorpay_payment_link_id: link.id,
    razorpay_payment_link_reference_id: link.reference_id,
    razorpay_payment_link_status: 'paid',
  };
  q.razorpay_signature = crypto
    .createHmac('sha256', 'rzp_test_secret')
    .update([q.razorpay_payment_link_id, q.razorpay_payment_link_reference_id, q.razorpay_payment_link_status, q.razorpay_payment_id].join('|'))
    .digest('hex');
  const res = await fetch(`${h.state.baseUrl}/api/payments/return?${new URLSearchParams(q)}`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, new RegExp(`abroo://payment/${started.paymentId}`));
  assert.match(html, /Payment received/);
  // Tampered redirect: no reconciliation is attributed to it.
  const tampered = await fetch(`${h.state.baseUrl}/api/payments/return?${new URLSearchParams({ ...q, razorpay_signature: 'bad' })}`);
  assert.match(await tampered.text(), /abroo:\/\/payment"/);
});

test('refunds: only unallocated money, via the gateway for online payments', async () => {
  // Overpay offline → advance → refund part of it.
  const extra = h.ok(await owner('POST', '/pg/payments', { tenantId: tenant.id, amount: 4000, method: 'CASH' }), 201);
  const tooMuch = await owner('POST', `/pg/payments/${extra.id}/refund`, { amount: extra.unappliedAmount + 1, reason: 'too much' });
  assert.equal(tooMuch.status, 409);
  const refund = h.ok(await owner('POST', `/pg/payments/${extra.id}/refund`, { amount: 1000, reason: 'Tenant request', method: 'CASH' }));
  assert.equal(refund.status, 'PROCESSED');
  const p = h.ok(await owner('GET', `/pg/payments/${extra.id}`));
  assert.equal(p.status, 'PARTIALLY_REFUNDED');
  assert.equal(p.refundedAmount, 1000);
});
