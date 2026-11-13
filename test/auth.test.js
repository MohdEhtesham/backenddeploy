const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const h = require('./helpers');

test.before(h.startStack);
test.after(h.stopStack);

test('legacy clients keep long-lived tokens; refresh-mode clients get short ones', async () => {
  const legacy = await h.signup({ refreshMode: false });
  const modern = await h.signup({ refreshMode: true });
  const lp = jwt.decode(legacy.token);
  const mp = jwt.decode(modern.token);
  assert.ok(lp.exp - lp.iat >= 29 * 24 * 3600, 'legacy token ~30d');
  assert.ok(mp.exp - mp.iat <= 15 * 60, 'refresh-mode access token 15m');
  assert.ok(legacy.refreshToken && modern.refreshToken, 'both receive a refresh token');
  assert.ok(lp.sid && mp.sid, 'tokens are bound to a session');
  // Existing response shape preserved.
  assert.equal(legacy.user.email, legacy.email);
  const me = h.ok(await h.api('GET', '/auth/me', { token: legacy.token }));
  assert.equal(me.id, legacy.user.id);
});

test('refresh rotates tokens and detects reuse', async () => {
  const u = await h.signup();
  const r1 = h.ok(await h.api('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } }));
  assert.notEqual(r1.refreshToken, u.refreshToken);
  h.ok(await h.api('GET', '/auth/me', { token: r1.token }));

  // Immediate replay of the rotated-out token: benign race, not fatal.
  const stale = await h.api('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.code, 'REFRESH_TOKEN_STALE');

  // Replay after the grace window ⇒ session revoked for everyone.
  const Session = require('../src/modules/auth/Session');
  const sid = u.refreshToken.split('.')[0];
  await Session.updateOne({ _id: sid }, { $set: { rotatedAt: new Date(Date.now() - 60 * 1000) } });
  const reuse = await h.api('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.code, 'REFRESH_TOKEN_REUSED');
  const after = await h.api('GET', '/auth/me', { token: r1.token });
  assert.equal(after.status, 401);
  assert.equal(after.body.code, 'SESSION_REVOKED');
});

test('logout revokes the session and its access token', async () => {
  const u = await h.signup();
  h.ok(await h.api('POST', '/auth/logout', { token: u.token, body: { refreshToken: u.refreshToken } }));
  const me = await h.api('GET', '/auth/me', { token: u.token });
  assert.equal(me.status, 401);
  const refreshed = await h.api('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
  assert.equal(refreshed.status, 401);
});

test('logout-all and session listing', async () => {
  const u = await h.signup();
  const second = await h.login(u.email);
  const sessions = h.ok(await h.api('GET', '/auth/sessions', { token: u.token }));
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter(s => s.current).length, 1);
  h.ok(await h.api('POST', '/auth/logout-all', { token: u.token }));
  assert.equal((await h.api('GET', '/auth/me', { token: second.token })).status, 401);
});

test('expired access tokens report TOKEN_EXPIRED (client refreshes)', async () => {
  const u = await h.signup();
  const payload = jwt.decode(u.token);
  const expired = jwt.sign({ sub: payload.sub, role: payload.role, sid: payload.sid, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET);
  const res = await h.api('GET', '/auth/me', { token: expired });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'TOKEN_EXPIRED');
  // Sockets accept it while the session is alive (long-lived connections).
  const { verifySocketToken } = require('../src/modules/auth/socketAuth');
  const p = await verifySocketToken(expired);
  assert.equal(p.sub, payload.sub);
  await h.api('POST', '/auth/logout', { token: u.token });
  await assert.rejects(() => verifySocketToken(expired));
});

test('OTP: hashed, single-use, attempt-limited, rate-limited', async () => {
  const phone = h.nextPhone();
  const sent = h.ok(await h.api('POST', '/auth/otp/send', { body: { phone } }));
  assert.match(sent.otp, /^\d{4}$/);
  const Otp = require('../src/modules/auth/Otp');
  const row = await Otp.findOne({ phone }).lean();
  assert.notEqual(row.codeHash, sent.otp, 'code is not stored in plain text');

  const wrong = sent.otp === '0000' ? '1111' : '0000';
  const bad = await h.api('POST', '/auth/otp/verify', { body: { phone, otp: wrong } });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.code, 'OTP_INVALID');
  const good = h.ok(await h.api('POST', '/auth/otp/verify', { body: { phone, otp: sent.otp } }));
  assert.ok(good.token && good.user.phone === phone);
  const reuse = await h.api('POST', '/auth/otp/verify', { body: { phone, otp: sent.otp } });
  assert.equal(reuse.status, 401, 'single use');

  // Attempts are capped per code.
  const again = h.ok(await h.api('POST', '/auth/otp/send', { body: { phone } }));
  const wrong2 = again.otp === '0000' ? '1111' : '0000';
  for (let i = 0; i < 5; i += 1) await h.api('POST', '/auth/otp/verify', { body: { phone, otp: wrong2 } });
  const locked = await h.api('POST', '/auth/otp/verify', { body: { phone, otp: again.otp } });
  assert.ok([401, 429].includes(locked.status), 'locked after too many attempts');

  // Hourly send cap per phone.
  let last;
  for (let i = 0; i < 6; i += 1) last = await h.api('POST', '/auth/otp/send', { body: { phone } });
  assert.equal(last.status, 429);
});

test('a login "role tab" never demotes an admin and needs an explicit role', async () => {
  const admin = await h.makeSuperAdmin();
  const res = h.ok(await h.api('POST', '/auth/login', { body: { identifier: admin.email, password: 'Passw0rd!', role: 'consumer' } }));
  assert.equal(res.user.role, 'admin');

  const seller = await h.signup();
  h.ok(await h.api('POST', '/auth/login', { body: { identifier: seller.email, password: 'Passw0rd!', role: 'seller' } }));
  const noRole = h.ok(await h.api('POST', '/auth/login', { body: { identifier: seller.email, password: 'Passw0rd!' } }));
  assert.equal(noRole.user.role, 'seller', 'no role in body → role unchanged (PG app)');
});

test('input validation and NoSQL-injection hardening on auth', async () => {
  const injection = await h.api('POST', '/auth/login', { body: { identifier: { $gt: '' }, password: 'x' } });
  assert.equal(injection.status, 400);
  assert.equal(injection.body.code, 'VALIDATION_ERROR');
  const malformed = await h.api('POST', '/auth/login', { raw: '{"identifier":', headers: { 'Content-Type': 'application/json' } });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, 'INVALID_JSON');
  const badPhone = await h.api('POST', '/auth/signup', { body: { fullName: 'A B', email: 'a@b.co', phone: '12345', password: 'secret1' } });
  assert.equal(badPhone.status, 400);
  assert.ok(Array.isArray(badPhone.body.details));
  assert.ok(badPhone.body.requestId, 'errors carry a request id');
});

test('account deletion is blocked for PG owners', async () => {
  const ctx = await h.makeOrg({ name: 'Delete Guard PG', rooms: [] });
  const res = await h.api('DELETE', '/auth/me', { token: ctx.owner.token });
  assert.equal(res.status, 409);
});
