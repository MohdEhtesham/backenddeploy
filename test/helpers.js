// Shared test harness: in-memory MongoDB replica set (transactions work),
// the real Express app on an ephemeral port, a fake Razorpay HTTP layer
// (so the real signing / verification code runs), and captured
// notification channels.
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STORAGE_DIR = path.join(os.tmpdir(), `aabroo-test-storage-${process.pid}`);

Object.assign(process.env, {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  JWT_SECRET: 'test-jwt-secret-with-enough-entropy-0123456789',
  JWT_EXPIRES_IN: '30d',
  ACCESS_TOKEN_TTL: '15m',
  OTP_MODE: 'random',
  OTP_DEV_ECHO: 'true',
  OTP_RESEND_COOLDOWN_SECONDS: '0',
  AUTH_RATE_LIMIT_MAX: '100000',
  RATE_LIMIT_MAX: '1000000',
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec_test_secret',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  FILE_URL_SECRET: 'file-url-secret-for-tests',
  PUBLIC_API_URL: 'http://127.0.0.1',
  JOBS_ENABLED: 'false',
  CRON_SECRET: 'cron-secret-for-tests',
  SAAS_TRIAL_DAYS: '14',
  API_DOCS_ENABLED: 'true',
});

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');

const state = { replSet: null, server: null, baseUrl: '', captured: { push: [], sms: [], email: [], whatsapp: [] }, rzp: null };

// ---- Fake Razorpay ------------------------------------------------------------

const fakeRazorpay = () => {
  const links = new Map();
  let seq = 0;
  const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) });
  const http = async (url, opts = {}) => {
    const u = new URL(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'POST' && u.pathname === '/v1/payment_links') {
      const body = JSON.parse(opts.body);
      const id = `plink_${++seq}_${crypto.randomBytes(3).toString('hex')}`;
      const link = { id, short_url: `https://rzp.io/i/${id}`, status: 'created', amount: body.amount, amount_paid: 0, currency: body.currency, reference_id: body.reference_id, notes: body.notes, payments: [] };
      links.set(id, link);
      return resp(200, link);
    }
    const linkMatch = u.pathname.match(/^\/v1\/payment_links\/([^/]+)(\/cancel)?$/);
    if (linkMatch) {
      const link = links.get(decodeURIComponent(linkMatch[1]));
      if (!link) return resp(404, { error: { description: 'Payment link not found' } });
      if (linkMatch[2]) link.status = 'cancelled';
      return resp(200, link);
    }
    if (method === 'POST' && /^\/v1\/payments\/[^/]+\/refund$/.test(u.pathname)) {
      return resp(200, { id: `rfnd_${++seq}`, status: 'processed' });
    }
    return resp(404, { error: { description: 'unknown endpoint' } });
  };
  /** Simulate the customer paying (optionally a different amount in paise). */
  const pay = (id, paise) => {
    const link = links.get(id);
    link.status = 'paid';
    link.amount_paid = paise ?? link.amount;
    const paymentId = `pay_${++seq}`;
    link.payments.push({ payment_id: paymentId, status: 'captured', amount: link.amount_paid });
    return { link, paymentId };
  };
  return { http, links, pay };
};

// ---- Lifecycle ------------------------------------------------------------------

const startStack = async () => {
  state.replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(state.replSet.getUri(), { dbName: 'aabroo_test' });

  const { createApp } = require('../src/app');
  const app = createApp();
  // Build every index before tests rely on unique constraints. The legacy
  // marketplace Property schema declares three separate text indexes
  // (MongoDB allows one per collection) — in production Mongoose only logs
  // that; it is tolerated here too. Every new model must index cleanly.
  const LEGACY_INDEX_ISSUES = new Set(['Property']);
  await Promise.all(
    Object.values(mongoose.models).map(m =>
      m.init().catch(e => {
        if (!LEGACY_INDEX_ISSUES.has(m.modelName)) throw e;
      }),
    ),
  );
  await require('../src/modules/saas/services/rbac').seedRbac();
  await require('../src/modules/saas/services/plans').seedPlans();
  await require('../src/modules/core/tx').detectTransactionSupport();

  const { createRazorpayGateway } = require('../src/modules/payments/gateway/razorpay');
  state.rzp = fakeRazorpay();
  require('../src/modules/payments/gateway').setGateway(
    createRazorpayGateway({ keyId: 'rzp_test_key', keySecret: 'rzp_test_secret', webhookSecret: 'whsec_test_secret', http: state.rzp.http }),
  );

  const capture = channel => ({
    send: async (...args) => {
      state.captured[channel].push(args);
      return { ok: true };
    },
  });
  require('../src/modules/notifications/channels/push').setDriver(capture('push'));
  require('../src/modules/notifications/channels/sms').setDriver(capture('sms'));
  require('../src/modules/notifications/channels/email').setDriver(capture('email'));
  require('../src/modules/notifications/channels/whatsapp').setDriver(capture('whatsapp'));

  await new Promise(resolve => {
    state.server = app.listen(0, '127.0.0.1', resolve);
  });
  state.baseUrl = `http://127.0.0.1:${state.server.address().port}`;
  return state;
};

const stopStack = async () => {
  await require('../src/modules/notifications/dispatcher').flush();
  if (state.server) await new Promise(r => state.server.close(r));
  await mongoose.disconnect();
  if (state.replSet) await state.replSet.stop();
  require('fs').rmSync(STORAGE_DIR, { recursive: true, force: true });
};

const flushNotifications = () => require('../src/modules/notifications/dispatcher').flush();

// ---- HTTP -------------------------------------------------------------------------

/**
 * api('POST', '/pg/tenants', { token, org, body, headers })
 * → { status, body, headers }
 */
const api = async (method, urlPath, { token, org, body, headers = {}, raw } = {}) => {
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (org) h['X-Org-Id'] = org;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${state.baseUrl}/api${urlPath}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
};

const ok = (res, status = 200) => {
  if (res.status !== status) {
    throw new Error(`Expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body && res.body.data !== undefined ? res.body.data : res.body;
};

// ---- Fixtures ------------------------------------------------------------------------

let phoneSeq = 0;
const nextPhone = () => {
  phoneSeq += 1;
  return `9${String(process.pid % 1000).padStart(3, '0')}${String(phoneSeq).padStart(6, '0')}`;
};

/** Sign up a fresh user (optionally in refresh-token mode). */
const signup = async ({ fullName = 'Test User', refreshMode = true } = {}) => {
  const phone = nextPhone();
  const email = `user${phone}@example.com`;
  const res = await api('POST', '/auth/signup', {
    body: { fullName, email, phone, password: 'Passw0rd!' },
    headers: refreshMode ? { 'X-Auth-Mode': 'refresh' } : {},
  });
  const data = ok(res, 201);
  return { ...data, phone, email, password: 'Passw0rd!' };
};

/** Log in (password) an existing account. */
const login = async (identifier, password = 'Passw0rd!', extra = {}) =>
  ok(await api('POST', '/auth/login', { body: { identifier, password, ...extra }, headers: { 'X-Auth-Mode': 'refresh' } }));

/** OTP sign-in (dev echo returns the code). */
const otpLogin = async phone => {
  const sent = ok(await api('POST', '/auth/otp/send', { body: { phone } }));
  return ok(await api('POST', '/auth/otp/verify', { body: { phone, otp: sent.otp }, headers: { 'X-Auth-Mode': 'refresh' } }));
};

const makeSuperAdmin = async () => {
  const u = await signup({ fullName: 'Platform Admin' });
  const User = require('../src/models/User');
  await User.updateOne({ _id: u.user.id }, { $set: { role: 'admin' } });
  return u;
};

/** Owner + organization (trial) + one property with a building, floor, rooms and beds. */
const makeOrg = async ({ name = 'Sunrise PG', rooms = [{ roomNumber: '101', roomType: 'DOUBLE', rentPerBed: 9000, depositPerBed: 18000 }] } = {}) => {
  const owner = await signup({ fullName: `${name} Owner` });
  const org = ok(await api('POST', '/pg/organizations', { token: owner.token, body: { name, city: 'Pune' } }), 201);
  const orgId = org.organization.id;
  const property = ok(
    await api('POST', '/pg/properties', {
      token: owner.token,
      org: orgId,
      body: {
        name: `${name} Main`,
        propertyType: 'PG',
        genderType: 'UNISEX',
        address: { line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
      },
    }),
    201,
  );
  const building = ok(await api('POST', '/pg/buildings', { token: owner.token, org: orgId, body: { propertyId: property.id, name: 'Block A' } }), 201);
  const floor = ok(await api('POST', '/pg/floors', { token: owner.token, org: orgId, body: { propertyId: property.id, buildingId: building.id, name: 'Ground', level: 0 } }), 201);
  const createdRooms = [];
  for (const room of rooms) {
    createdRooms.push(
      ok(await api('POST', '/pg/rooms', { token: owner.token, org: orgId, body: { propertyId: property.id, buildingId: building.id, floorId: floor.id, ...room } }), 201),
    );
  }
  return { owner, orgId, org: org.organization, property, building, floor, rooms: createdRooms, beds: createdRooms.flatMap(r => r.beds) };
};

/** Prospect tenant in an organization. */
const makeTenant = async (ctx, overrides = {}) =>
  ok(
    await api('POST', '/pg/tenants', {
      token: ctx.owner.token,
      org: ctx.orgId,
      body: { fullName: overrides.fullName || 'Rahul Sharma', phone: overrides.phone || nextPhone(), email: 'tenant@example.com', ...overrides },
    }),
    201,
  );

const checkIn = async (ctx, tenantId, bedId, body = {}) =>
  ok(await api('POST', '/pg/checkins', { token: ctx.owner.token, org: ctx.orgId, body: { tenantId, bedId, ...body } }), 201);

/** Invite + accept a team member with a given role; returns their auth. */
const addMember = async (ctx, role, extra = {}) => {
  const phone = nextPhone();
  ok(await api('POST', '/pg/users/invite', { token: ctx.owner.token, org: ctx.orgId, body: { phone, fullName: `${role} Person`, role, ...extra } }), 201);
  const auth = await otpLogin(phone);
  const inv = ok(await api('GET', '/pg/me/invitations', { token: auth.token }));
  const mine = inv.find(i => i.organizationId === ctx.orgId);
  ok(await api('POST', `/pg/me/invitations/${mine.id}/accept`, { token: auth.token }));
  return { ...auth, phone };
};

/** Signed Razorpay webhook delivery. */
const deliverWebhook = async (payload, { eventId = `evt_${crypto.randomBytes(6).toString('hex')}`, secret = 'whsec_test_secret', signature } = {}) => {
  const raw = JSON.stringify(payload);
  const sig = signature || crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return api('POST', '/webhooks/razorpay', {
    raw,
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': eventId },
  });
};

const paidEvent = (link, paymentId) => ({
  event: 'payment_link.paid',
  payload: {
    payment_link: { entity: { id: link.id, reference_id: link.reference_id, amount_paid: link.amount_paid, currency: link.currency || 'INR', status: 'paid' } },
    payment: { entity: { id: paymentId, amount: link.amount_paid, status: 'captured' } },
  },
});

// Same calendar day the server uses (organization time zone, IST).
const todayKey = () => {
  const D = require('../src/modules/core/dates');
  return D.dayKey(D.todayIn('Asia/Kolkata'));
};

module.exports = {
  state,
  startStack,
  stopStack,
  flushNotifications,
  api,
  ok,
  nextPhone,
  signup,
  login,
  otpLogin,
  makeSuperAdmin,
  makeOrg,
  makeTenant,
  checkIn,
  addMember,
  deliverWebhook,
  paidEvent,
  todayKey,
};
