// Plans, trials, entitlements, lifecycle, billing — all server-enforced.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let admin;
let expiredCtx;

test.before(async () => {
  await h.startStack();
  admin = await h.makeSuperAdmin();
});
test.after(h.stopStack);

const Subscription = require('../src/modules/saas/models/Subscription');
const { unscoped } = require('../src/modules/core/scope');

const setSub = (orgId, patch) => unscoped(() => Subscription.updateOne({ organizationId: orgId }, { $set: patch }));

test('a new organization starts a trial using the configurable trial length', async () => {
  h.ok(await h.api('PUT', '/pg/admin/settings', { token: admin.token, body: { trialDays: 21 } }));
  const ctx = await h.makeOrg({ name: 'Trial Length PG', rooms: [] });
  const sub = h.ok(await h.api('GET', '/pg/subscription', { token: ctx.owner.token, org: ctx.orgId }));
  assert.equal(sub.status, 'TRIAL');
  assert.equal(sub.planCode, 'BUSINESS');
  assert.ok(sub.trialDaysLeft >= 20 && sub.trialDaysLeft <= 21, `trialDaysLeft=${sub.trialDaysLeft}`);
  h.ok(await h.api('PUT', '/pg/admin/settings', { token: admin.token, body: { trialDays: 14 } }));
});

test('one trial per owner — the next organization starts on Free', async () => {
  const first = await h.makeOrg({ name: 'Owner First', rooms: [] });
  const second = h.ok(await h.api('POST', '/pg/organizations', { token: first.owner.token, body: { name: 'Owner Second' } }), 201);
  assert.equal(second.subscription.status, 'ACTIVE');
  assert.equal(second.subscription.planCode, 'FREE');
});

test('plan limits are enforced from plan data (not hard-coded)', async () => {
  const ctx = await h.makeOrg({ name: 'Limit PG', rooms: [] });
  await h.api('POST', `/pg/admin/subscriptions/${ctx.orgId}/change-plan`, { token: admin.token, body: { planCode: 'FREE' } });
  const res = await h.api('POST', '/pg/properties', {
    token: ctx.owner.token,
    org: ctx.orgId,
    body: { name: 'Second property', propertyType: 'PG', genderType: 'UNISEX', address: { city: 'Pune', state: 'MH', pincode: '411001' } },
  });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'PLAN_LIMIT_REACHED');
  assert.equal(res.body.details.limit, 1);

  // Super admin grants an override → allowed without changing the plan.
  h.ok(await h.api('PUT', `/pg/admin/subscriptions/${ctx.orgId}/overrides`, { token: admin.token, body: { limits: { maxProperties: 2 } } }));
  const ok = await h.api('POST', '/pg/properties', {
    token: ctx.owner.token,
    org: ctx.orgId,
    body: { name: 'Second property', propertyType: 'PG', genderType: 'UNISEX', address: { city: 'Pune', state: 'MH', pincode: '411001' } },
  });
  assert.equal(ok.status, 201);

  // Editing the plan document changes enforcement for everyone on it.
  const plans = h.ok(await h.api('GET', '/pg/admin/plans', { token: admin.token })).plans;
  const free = plans.find(p => p.code === 'FREE');
  h.ok(await h.api('PUT', `/pg/admin/plans/${free.id}`, { token: admin.token, body: { limits: { ...free.limits, maxBeds: 3 } } }));
  const room = await h.api('POST', '/pg/rooms', {
    token: ctx.owner.token,
    org: ctx.orgId,
    body: { propertyId: ctx.property.id, buildingId: ctx.building.id, floorId: ctx.floor.id, roomNumber: 'L1', roomType: 'FOUR_SHARING', rentPerBed: 5000 },
  });
  assert.equal(room.status, 402);
  h.ok(await h.api('PUT', `/pg/admin/plans/${free.id}`, { token: admin.token, body: { limits: free.limits } }));
});

test('features are gated by plan', async () => {
  const ctx = await h.makeOrg({ name: 'Feature PG', rooms: [] });
  h.ok(await h.api('POST', `/pg/admin/subscriptions/${ctx.orgId}/change-plan`, { token: admin.token, body: { planCode: 'FREE' } }));
  const staff = await h.api('POST', '/pg/staff', { token: ctx.owner.token, org: ctx.orgId, body: { fullName: 'Cook', phone: h.nextPhone(), jobRole: 'COOK', department: 'KITCHEN' } });
  assert.equal(staff.status, 402);
  assert.equal(staff.body.code, 'FEATURE_NOT_IN_PLAN');
  const advanced = await h.api('GET', '/pg/reports/profit', { token: ctx.owner.token, org: ctx.orgId });
  assert.equal(advanced.status, 402);
  const basic = await h.api('GET', '/pg/reports/revenue', { token: ctx.owner.token, org: ctx.orgId });
  assert.equal(basic.status, 200);
});

test('expired subscriptions are read-only; the client cannot change its own status', async () => {
  const ctx = await h.makeOrg({ name: 'Expiry PG', rooms: [] });
  await setSub(ctx.orgId, { trialEndsAt: new Date(Date.now() - 1000) });
  const write = await h.api('POST', '/pg/buildings', { token: ctx.owner.token, org: ctx.orgId, body: { propertyId: ctx.property.id, name: 'Block Z' } });
  assert.equal(write.status, 402);
  assert.equal(write.body.code, 'SUBSCRIPTION_INACTIVE');
  const read = h.ok(await h.api('GET', '/pg/buildings', { token: ctx.owner.token, org: ctx.orgId }));
  assert.ok(read.items.length >= 1, 'data stays readable');
  const sub = h.ok(await h.api('GET', '/pg/subscription', { token: ctx.owner.token, org: ctx.orgId }));
  assert.equal(sub.status, 'EXPIRED');
  // No endpoint accepts a client-provided status / plan.
  const tamper = await h.api('PUT', '/pg/subscription', { token: ctx.owner.token, org: ctx.orgId, body: { status: 'ACTIVE', planCode: 'ENTERPRISE' } });
  assert.equal(tamper.status, 404);
  assert.equal(h.ok(await h.api('GET', '/pg/subscription', { token: ctx.owner.token, org: ctx.orgId })).status, 'EXPIRED');
  expiredCtx = ctx;
});

test('free plan activates instantly; paid plans only after a verified payment', async () => {
  const ctx = expiredCtx;
  const free = h.ok(await h.api('POST', '/pg/subscription/checkout', { token: ctx.owner.token, org: ctx.orgId, body: { planCode: 'FREE' } }));
  assert.equal(free.activated, true);
  assert.equal(h.ok(await h.api('GET', '/pg/subscription', { token: ctx.owner.token, org: ctx.orgId })).status, 'ACTIVE');

  const paid = h.ok(await h.api('POST', '/pg/subscription/checkout', { token: ctx.owner.token, org: ctx.orgId, body: { planCode: 'STARTER', billingCycle: 'MONTHLY' } }));
  assert.equal(paid.activated, false);
  assert.equal(paid.amount, 999);
  let sub = h.ok(await h.api('GET', '/pg/subscription', { token: ctx.owner.token, org: ctx.orgId }));
  assert.equal(sub.planCode, 'FREE', 'nothing changes before payment');

  const link = [...h.state.rzp.links.values()].find(l => l.reference_id === paid.paymentId);
  const { link: paidLink, paymentId } = h.state.rzp.pay(link.id);
  h.ok(await h.deliverWebhook(h.paidEvent(paidLink, paymentId)));
  sub = h.ok(await h.api('GET', '/pg/subscription', { token: ctx.owner.token, org: ctx.orgId }));
  assert.equal(sub.planCode, 'STARTER');
  assert.equal(sub.status, 'ACTIVE');
  assert.ok(new Date(sub.currentPeriodEnd) > new Date());
  const history = h.ok(await h.api('GET', '/pg/subscription/payments', { token: ctx.owner.token, org: ctx.orgId })).items;
  assert.equal(history[0].status, 'SUCCEEDED');
  assert.match(history[0].invoiceNumber, /^SUB-/);
});

test('coupons discount checkout and are validated server-side', async () => {
  h.ok(await h.api('POST', '/pg/admin/coupons', { token: admin.token, body: { code: 'LAUNCH50', type: 'PERCENT', value: 50, planCodes: ['BUSINESS'], maxRedemptions: 1 } }), 201);
  const ctx = await h.makeOrg({ name: 'Coupon PG', rooms: [] });
  const quote = h.ok(await h.api('POST', '/pg/subscription/quote', { token: ctx.owner.token, org: ctx.orgId, body: { planCode: 'BUSINESS', couponCode: 'launch50' } }));
  assert.equal(quote.amount, 1249.5);
  const wrongPlan = await h.api('POST', '/pg/subscription/quote', { token: ctx.owner.token, org: ctx.orgId, body: { planCode: 'STARTER', couponCode: 'LAUNCH50' } });
  assert.equal(wrongPlan.body.code, 'COUPON_NOT_APPLICABLE');
  const bogus = await h.api('POST', '/pg/subscription/quote', { token: ctx.owner.token, org: ctx.orgId, body: { planCode: 'BUSINESS', couponCode: 'NOPE' } });
  assert.equal(bogus.body.code, 'COUPON_INVALID');
});

test('downgrade is blocked when usage exceeds the target plan', async () => {
  const ctx = await h.makeOrg({ name: 'Big PG', rooms: [{ roomNumber: '1', roomType: 'FOUR_SHARING', rentPerBed: 1 }] });
  for (let i = 2; i <= 6; i += 1) {
    h.ok(
      await h.api('POST', '/pg/rooms', { token: ctx.owner.token, org: ctx.orgId, body: { propertyId: ctx.property.id, buildingId: ctx.building.id, floorId: ctx.floor.id, roomNumber: String(i), roomType: 'FOUR_SHARING', rentPerBed: 1 } }),
      201,
    );
  }
  const res = await h.api('POST', '/pg/subscription/checkout', { token: ctx.owner.token, org: ctx.orgId, body: { planCode: 'FREE' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PLAN_DOWNGRADE_BLOCKED');
});

test('lifecycle: past due within grace stays writable; super admin controls', async () => {
  const ctx = await h.makeOrg({ name: 'Lifecycle PG', rooms: [] });
  h.ok(await h.api('POST', `/pg/admin/subscriptions/${ctx.orgId}/change-plan`, { token: admin.token, body: { planCode: 'STARTER' } }));
  await setSub(ctx.orgId, { currentPeriodEnd: new Date(Date.now() - 2 * 86400000) });
  let sub = h.ok(await h.api('GET', '/pg/subscription', { token: ctx.owner.token, org: ctx.orgId }));
  assert.equal(sub.status, 'PAST_DUE');
  assert.ok(sub.graceEndsAt);
  h.ok(await h.api('POST', '/pg/buildings', { token: ctx.owner.token, org: ctx.orgId, body: { propertyId: ctx.property.id, name: 'Grace Block' } }), 201);

  h.ok(await h.api('POST', `/pg/admin/subscriptions/${ctx.orgId}/suspend`, { token: admin.token, body: { reason: 'Chargeback' } }));
  sub = h.ok(await h.api('GET', '/pg/subscription', { token: ctx.owner.token, org: ctx.orgId }));
  assert.equal(sub.status, 'SUSPENDED');
  assert.equal((await h.api('POST', '/pg/buildings', { token: ctx.owner.token, org: ctx.orgId, body: { propertyId: ctx.property.id, name: 'Blocked' } })).status, 402);
  h.ok(await h.api('POST', `/pg/admin/subscriptions/${ctx.orgId}/reactivate`, { token: admin.token }));
  h.ok(await h.api('POST', `/pg/admin/subscriptions/${ctx.orgId}/extend-trial`, { token: admin.token, body: { days: 10 } }));
  sub = h.ok(await h.api('GET', '/pg/subscription', { token: ctx.owner.token, org: ctx.orgId }));
  assert.equal(sub.status, 'TRIAL');
});

test('cancel at period end keeps access until the period ends', async () => {
  const ctx = await h.makeOrg({ name: 'Cancel PG', rooms: [] });
  h.ok(await h.api('POST', `/pg/admin/subscriptions/${ctx.orgId}/change-plan`, { token: admin.token, body: { planCode: 'BUSINESS' } }));
  const c = h.ok(await h.api('POST', '/pg/subscription/cancel', { token: ctx.owner.token, org: ctx.orgId }));
  assert.equal(c.cancelAtPeriodEnd, true);
  assert.equal(c.status, 'ACTIVE');
  const resumed = h.ok(await h.api('POST', '/pg/subscription/resume', { token: ctx.owner.token, org: ctx.orgId }));
  assert.equal(resumed.cancelAtPeriodEnd, false);
  h.ok(await h.api('POST', '/pg/subscription/cancel', { token: ctx.owner.token, org: ctx.orgId }));
  await setSub(ctx.orgId, { currentPeriodEnd: new Date(Date.now() - 1000) });
  assert.equal(h.ok(await h.api('GET', '/pg/subscription', { token: ctx.owner.token, org: ctx.orgId })).status, 'CANCELLED');
});

test('subscription job sends expiry reminders once', async () => {
  const ctx = await h.makeOrg({ name: 'Reminder PG', rooms: [] });
  await setSub(ctx.orgId, { trialEndsAt: new Date(Date.now() + 2 * 86400000) });
  const { runJob } = require('../src/modules/jobs/scheduler');
  const r1 = await runJob('subscriptions');
  const r2 = await runJob('subscriptions');
  assert.ok(r1.reminded >= 1);
  assert.equal(r2.reminded, 0);
  await h.flushNotifications();
  const Notification = require('../src/models/Notification');
  assert.equal(await Notification.countDocuments({ organizationId: ctx.orgId, type: 'subscription' }), 1);
});
