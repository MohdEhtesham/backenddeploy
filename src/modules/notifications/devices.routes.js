const { createRouter } = require('../core/router');
const { z, text } = require('../core/validation');
const DeviceToken = require('./DeviceToken');
const { uuid } = require('../core/ids');

// Push token registry (FCM / APNs), shared by both products.
const r = createRouter({ prefix: '/devices', tag: 'Notifications' });

const TokenDto = z.object({
  token: z.string().trim().min(20).max(4096),
  platform: z.enum(['ios', 'android', 'web']),
  provider: z.enum(['fcm', 'apns']).default('fcm'),
  appVersion: text(20).optional(),
  deviceId: text(100).optional(),
});

r.post('/', { auth: 'user', body: TokenDto, summary: 'Register this device for push notifications' }, async req => {
  const b = req.valid.body;
  const doc = await DeviceToken.findOneAndUpdate(
    { token: b.token },
    {
      $set: {
        userId: req.user._id,
        platform: b.platform,
        provider: b.provider,
        appVersion: b.appVersion || '',
        deviceId: b.deviceId || '',
        enabled: true,
        lastSeenAt: new Date(),
      },
      $setOnInsert: { _id: uuid() },
    },
    { upsert: true, new: true, setDefaultsOnInsert: false },
  ).lean();
  return { id: doc._id, registered: true };
});

r.delete('/', { auth: 'user', body: z.object({ token: z.string().trim().min(20).max(4096) }), summary: 'Unregister this device' }, async req => {
  const res = await DeviceToken.deleteOne({ token: req.valid.body.token, userId: req.user._id });
  return { removed: res.deletedCount > 0 };
});

module.exports = r.router;
