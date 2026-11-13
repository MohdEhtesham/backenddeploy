const jwt = require('jsonwebtoken');
const env = require('../../../config/env');

// Push channel. Drivers: console (dev), fcm (Firebase Cloud Messaging HTTP
// v1 — OAuth2 service-account flow implemented directly, no SDK needed).
// Returns { ok, invalidToken } so the dispatcher can prune dead tokens.

let cachedAccess = null;

const fcmAccessToken = async () => {
  if (cachedAccess && cachedAccess.expiresAt > Date.now() + 60_000) return cachedAccess.token;
  const { clientEmail, privateKey } = env.FCM;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    privateKey,
    { algorithm: 'RS256' },
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`FCM auth ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  cachedAccess = { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
  return cachedAccess.token;
};

// FCM data payload values must be strings.
const stringify = data =>
  Object.fromEntries(
    Object.entries(data || {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  );

const drivers = {
  console: {
    async send(token, { title, body }) {
      console.log(`[push:console] → ${String(token).slice(0, 12)}…: ${title} — ${body}`);
      return { ok: true, driver: 'console' };
    },
  },

  fcm: {
    async send(token, { title, body, data }) {
      const { projectId, clientEmail, privateKey } = env.FCM;
      if (!projectId || !clientEmail || !privateKey) throw new Error('FCM is not configured');
      const access = await fcmAccessToken();
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: stringify(data),
            android: { priority: 'high', notification: { channel_id: 'default', sound: 'default' } },
            apns: { payload: { aps: { sound: 'default' } } },
          },
        }),
      });
      if (res.ok) return { ok: true, driver: 'fcm' };
      const text = await res.text();
      const invalidToken = res.status === 404 || /UNREGISTERED|registration-token-not-registered/i.test(text);
      if (invalidToken) return { ok: false, invalidToken: true, driver: 'fcm' };
      throw new Error(`FCM ${res.status}: ${text.slice(0, 300)}`);
    },
  },
};

let override = null;
const driver = () => override || drivers[env.PUSH_PROVIDER] || drivers.console;

module.exports = {
  send: (token, message) => driver().send(token, message),
  setDriver: d => {
    override = d;
  },
  drivers,
};
