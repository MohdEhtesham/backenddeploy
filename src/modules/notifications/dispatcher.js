const Notification = require('../../models/Notification');
const User = require('../../models/User');
const DeviceToken = require('./DeviceToken');
const push = require('./channels/push');
const sms = require('./channels/sms');
const email = require('./channels/email');
const whatsapp = require('./channels/whatsapp');

// Notification dispatcher.
//
// notify() writes in-app rows first (always), then fans out to push and,
// when the organization's plan includes the `notifications` feature, to
// SMS / WhatsApp / email. Delivery failures are logged and never bubble up
// into the business flow that triggered them. Work is tracked so tests (and
// graceful shutdown) can await completion with flush().

const pending = new Set();

const track = promise => {
  pending.add(promise);
  promise.finally(() => pending.delete(promise));
  return promise;
};

const uniq = ids => [...new Set((ids || []).filter(Boolean).map(String))];

const paidChannelsAllowed = async organizationId => {
  if (!organizationId) return true;
  try {
    // Lazy require avoids a load-order cycle (entitlements → models → …).
    const { hasFeature } = require('../saas/services/entitlements');
    return await hasFeature(organizationId, 'notifications');
  } catch (e) {
    console.warn('[notify] entitlement check failed', e.message);
    return false;
  }
};

const deliver = async ({
  userIds,
  organizationId = null,
  module = 'pg',
  type,
  title,
  body,
  data = null,
  channels = ['inapp', 'push'],
  smsText,
  emailSubject,
  whatsappTemplate,
}) => {
  const ids = uniq(userIds);
  if (!ids.length) return { inapp: 0, push: 0 };
  const result = { inapp: 0, push: 0, sms: 0, email: 0, whatsapp: 0 };

  if (channels.includes('inapp')) {
    const docs = await Notification.insertMany(
      ids.map(userId => ({ userId, type, title, body, module, organizationId, data, actionId: data && data.id ? String(data.id) : undefined })),
      { ordered: false },
    );
    result.inapp = docs.length;
  }

  const users = await User.find({ _id: { $in: ids } }).select('phone email preferences fullName').lean();
  const optedIn = users.filter(u => !u.preferences || u.preferences.notificationsEnabled !== false);

  if (channels.includes('push') && optedIn.length) {
    const tokens = await DeviceToken.find({ userId: { $in: optedIn.map(u => u._id) }, enabled: true }).lean();
    await Promise.all(
      tokens.map(async t => {
        try {
          const r = await push.send(t.token, { title, body, data: { ...(data || {}), type, module } });
          if (r && r.invalidToken) await DeviceToken.updateOne({ _id: t._id }, { $set: { enabled: false } });
          else result.push += 1;
        } catch (e) {
          console.warn('[notify] push failed', e.message);
        }
      }),
    );
  }

  const wantsPaid = ['sms', 'whatsapp', 'email'].some(c => channels.includes(c));
  if (wantsPaid && optedIn.length && (await paidChannelsAllowed(organizationId))) {
    await Promise.all(
      optedIn.map(async u => {
        try {
          if (channels.includes('sms') && u.phone && !String(u.phone).startsWith('0000')) {
            await sms.send(u.phone, smsText || `${title}: ${body}`);
            result.sms += 1;
          }
          if (channels.includes('whatsapp') && u.phone) {
            await whatsapp.send({ to: u.phone, body: `*${title}*\n${body}`, template: whatsappTemplate });
            result.whatsapp += 1;
          }
          if (channels.includes('email') && u.email && !/@aabroo\.app$/.test(u.email)) {
            await email.send({ to: u.email, subject: emailSubject || title, text: body, html: `<p>${escapeHtml(body)}</p>` });
            result.email += 1;
          }
        } catch (e) {
          console.warn('[notify] channel failed', e.message);
        }
      }),
    );
  }
  return result;
};

const escapeHtml = s =>
  String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Fire-and-forget. Returns the delivery promise (never rejects). */
const notify = payload =>
  track(
    deliver(payload).catch(e => {
      console.warn('[notify] failed', e.message);
      return null;
    }),
  );

/** Await all in-flight deliveries (tests, graceful shutdown). */
const flush = () => Promise.allSettled([...pending]);

module.exports = { notify, flush, escapeHtml };
