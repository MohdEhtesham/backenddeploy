// Super admin console, OpenAPI, legacy compatibility, jobs endpoint,
// deep-link verification files, analytics ingestion.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let admin;
let orgA;
let orgB;

test.before(async () => {
  await h.startStack();
  admin = await h.makeSuperAdmin();
  orgA = await h.makeOrg({ name: 'Platform A', rooms: [{ roomNumber: '1', roomType: 'DOUBLE', rentPerBed: 6000 }] });
  orgB = await h.makeOrg({ name: 'Platform B', rooms: [{ roomNumber: '1', roomType: 'SINGLE', rentPerBed: 9000 }] });
  const t = await h.makeTenant(orgA);
  await h.checkIn(orgA, t.id, orgA.beds[0].id, { checkInDate: h.todayKey(), collect: { amount: 6000, method: 'CASH' } });
});
test.after(h.stopStack);

const sa = (method, path, body) => h.api(method, path, { token: admin.token, body });

test('super admin endpoints are closed to everyone else', async () => {
  for (const path of ['/pg/admin/dashboard', '/pg/admin/organizations', '/pg/admin/plans', '/pg/admin/audit-logs']) {
    const res = await h.api('GET', path, { token: orgA.owner.token, org: orgA.orgId });
    assert.equal(res.status, 403, path);
  }
  assert.equal((await h.api('GET', '/pg/admin/dashboard')).status, 401);
});

test('platform dashboard KPIs', async () => {
  const d = h.ok(await sa('GET', '/pg/admin/dashboard'));
  assert.equal(d.totalOrganizations, 2);
  assert.equal(d.trialOrganizations, 2);
  assert.equal(d.totalProperties, 2);
  assert.equal(d.totalBeds, 3);
  assert.equal(d.occupiedBeds, 1);
  assert.equal(d.totalTenants, 1);
  assert.equal(d.paymentVolume.rentAllTime, 6000);
  assert.equal(typeof d.mrr, 'number');
  assert.equal(typeof d.churnRate30d, 'number');
});

test('organizations, owners, properties, usage, trials', async () => {
  const orgs = h.ok(await sa('GET', '/pg/admin/organizations?q=Platform'));
  assert.equal(orgs.total, 2);
  const a = orgs.items.find(o => o.id === orgA.orgId);
  assert.equal(a.beds, 2);
  assert.equal(a.tenants, 1);
  assert.equal(a.subscription.status, 'TRIAL');
  const detail = h.ok(await sa('GET', `/pg/admin/organizations/${orgA.orgId}`));
  assert.equal(detail.usage.find(u => u.key === 'maxProperties').used, 1);
  assert.equal(h.ok(await sa('GET', '/pg/admin/owners')).total, 2);
  assert.equal(h.ok(await sa('GET', '/pg/admin/properties')).total, 2);
  assert.equal(h.ok(await sa('GET', '/pg/admin/trials')).total, 2);
  assert.equal(h.ok(await sa('GET', '/pg/admin/usage')).total, 2);
});

test('suspending an organization blocks its members; reactivation restores', async () => {
  h.ok(await sa('PUT', `/pg/admin/organizations/${orgB.orgId}`, { status: 'SUSPENDED', suspendedReason: 'KYC pending' }));
  const blocked = await h.api('GET', '/pg/tenants', { token: orgB.owner.token, org: orgB.orgId });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'ORG_SUSPENDED');
  h.ok(await sa('PUT', `/pg/admin/organizations/${orgB.orgId}`, { status: 'ACTIVE' }));
  h.ok(await h.api('GET', '/pg/tenants', { token: orgB.owner.token, org: orgB.orgId }));
});

test('plans, coupons, feature flags (with org targeting), settings', async () => {
  const plan = h.ok(await sa('POST', '/pg/admin/plans', { code: 'SEASONAL', name: 'Seasonal', priceMonthly: 499, priceYearly: 4990, limits: { maxProperties: 1, maxBeds: 40, maxUsers: 3, maxTenants: 40 }, features: { onlinePayments: true } }), 201);
  const bad = await sa('POST', '/pg/admin/plans', { code: 'BAD', name: 'Bad', priceMonthly: 1, priceYearly: 1, limits: { maxUnicorns: 1 } });
  assert.equal(bad.status, 400);
  const pub = h.ok(await h.api('GET', '/pg/subscription/plans', { token: orgA.owner.token }));
  assert.ok(pub.plans.some(p => p.code === 'SEASONAL'));
  h.ok(await sa('PUT', `/pg/admin/plans/${plan.id}`, { isPublic: false }));

  const flag = h.ok(await sa('POST', '/pg/admin/feature-flags', { key: 'pg.newDashboard', enabled: false, enabledOrgIds: [orgA.orgId] }), 201);
  const ctxA = h.ok(await h.api('GET', '/pg/me/context', { token: orgA.owner.token }));
  const ctxB = h.ok(await h.api('GET', '/pg/me/context', { token: orgB.owner.token }));
  assert.equal(ctxA.active.featureFlags['pg.newDashboard'], true);
  assert.equal(ctxB.active.featureFlags['pg.newDashboard'], false);
  h.ok(await sa('DELETE', `/pg/admin/feature-flags/${flag.id}`));

  const settings = h.ok(await sa('PUT', '/pg/admin/settings', { graceDays: 10, trialExpiryAction: 'DOWNGRADE_TO_FREE' }));
  assert.equal(settings.graceDays, 10);
  assert.equal((await sa('PUT', '/pg/admin/settings', { trialPlanCode: 'NOPE' })).status, 400);
});

test('support tickets flow between an organization and the platform', async () => {
  const t = h.ok(await h.api('POST', '/pg/support/tickets', { token: orgA.owner.token, org: orgA.orgId, body: { subject: 'Invoice question', message: 'Why is GST not shown?', category: 'BILLING' } }), 201);
  const list = h.ok(await sa('GET', '/pg/admin/support/tickets'));
  assert.ok(list.items.some(x => x.id === t.id && x.organizationName === 'Platform A'));
  h.ok(await sa('POST', `/pg/admin/support/tickets/${t.id}/messages`, { body: 'GST is configurable in settings.' }));
  const back = h.ok(await h.api('GET', `/pg/support/tickets/${t.id}`, { token: orgA.owner.token, org: orgA.orgId }));
  assert.equal(back.messages.length, 2);
  assert.equal(back.status, 'WAITING_ON_CUSTOMER');
  // Org B can't see it.
  assert.equal((await h.api('GET', `/pg/support/tickets/${t.id}`, { token: orgB.owner.token, org: orgB.orgId })).status, 404);
});

test('audit log captures mutations with actors', async () => {
  const logs = h.ok(await sa('GET', `/pg/admin/audit-logs?organizationId=${orgA.orgId}&pageSize=100`)).items;
  const actions = new Set(logs.map(l => l.action));
  for (const a of ['organization.create', 'property.create', 'room.create', 'tenant.create', 'checkin.create', 'support.create']) {
    assert.ok(actions.has(a), `missing audit action ${a}`);
  }
  const own = h.ok(await h.api('GET', '/pg/organization/audit-logs', { token: orgA.owner.token, org: orgA.orgId }));
  assert.ok(own.items.every(l => l.organizationId === orgA.orgId));
});

test('OpenAPI document covers the API', async () => {
  const res = await fetch(`${h.state.baseUrl}/api/docs/openapi.json`);
  const spec = await res.json();
  assert.equal(spec.openapi, '3.0.3');
  for (const p of ['/pg/tenants', '/pg/checkins', '/pg/checkouts', '/pg/invoices', '/pg/payments', '/pg/me/payments', '/pg/reports/{name}', '/pg/admin/dashboard', '/auth/login', '/properties']) {
    assert.ok(spec.paths[p], `missing ${p}`);
  }
  assert.ok(spec.paths['/pg/tenants'].post.requestBody.content['application/json'].schema.properties.phone);
  const html = await fetch(`${h.state.baseUrl}/api/docs`);
  assert.match(html.headers.get('content-security-policy'), /nonce-/);
});

test('existing marketplace + health endpoints still work', async () => {
  assert.equal((await fetch(`${h.state.baseUrl}/health`)).status, 200);
  const props = h.ok(await h.api('GET', '/properties'));
  assert.ok(Array.isArray(props.items));
  const u = await h.signup();
  const notifications = h.ok(await h.api('GET', '/notifications', { token: u.token }));
  assert.ok(Array.isArray(notifications));
  const unknown = await h.api('GET', '/does-not-exist');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'NOT_FOUND');
  const badId = await h.api('GET', '/properties/not-an-object-id');
  assert.ok([400, 404].includes(badId.status), 'malformed ids are not 500s');
});

test('deep-link verification files and fallback page', async () => {
  const android = await (await fetch(`${h.state.baseUrl}/.well-known/assetlinks.json`)).json();
  assert.ok(Array.isArray(android));
  const apple = await (await fetch(`${h.state.baseUrl}/.well-known/apple-app-site-association`)).json();
  assert.ok(apple.applinks);
  const page = await fetch(`${h.state.baseUrl}/pg/${orgA.property.id}`);
  assert.match(await page.text(), new RegExp(`abroo://pg/${orgA.property.id}`));
});

test('jobs endpoint requires the cron secret', async () => {
  assert.equal((await h.api('POST', '/internal/jobs/all')).status, 404);
  const run = h.ok(await h.api('POST', '/internal/jobs/generate-invoices', { headers: { 'X-Cron-Secret': 'cron-secret-for-tests' } }));
  assert.equal(run.job, 'generate-invoices');
  assert.ok(run.organizations >= 2);
});

test('analytics ingestion drops PII and unknown events', async () => {
  const res = await h.api('POST', '/analytics/events', {
    token: orgA.owner.token,
    body: { platform: 'android', appVersion: '1.0.0', events: [{ name: 'product_selected', module: 'pg', props: { product: 'PG', phone: '9999999999' } }] },
  });
  assert.equal(res.status, 202);
  const AnalyticsEvent = require('../src/modules/analytics/AnalyticsEvent');
  const ev = await AnalyticsEvent.findOne({ name: 'product_selected' }).lean();
  assert.equal(ev.props.product, 'PG');
  assert.equal(ev.props.phone, undefined);
  assert.ok(ev.actorHash && !ev.actorHash.includes(String(orgA.owner.user.id)));
  const unknown = await h.api('POST', '/analytics/events', { body: { events: [{ name: 'steal_data' }] } });
  assert.equal(unknown.status, 400);
  const stats = h.ok(await sa('GET', '/pg/admin/analytics'));
  assert.ok(stats.events.some(e => e.name === 'product_selected'));
});
