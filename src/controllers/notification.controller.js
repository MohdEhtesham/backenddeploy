const Notification = require('../models/Notification');
const { ok } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');

// Property-marketplace feed. PG notifications (module: 'pg') live in the
// same collection but are served by /api/pg/notifications, so they are
// excluded here; legacy documents without `module` still match.
const PROPERTY_ONLY = { module: { $ne: 'pg' } };

exports.list = asyncHandler(async (req, res) => {
  const items = await Notification.find({ userId: req.user._id, ...PROPERTY_ONLY })
    .sort({ createdAt: -1 })
    .limit(100);
  ok(res, items.map(i => i.toPublic()));
});

exports.markRead = asyncHandler(async (req, res) => {
  await Notification.updateOne({ _id: req.params.id, userId: req.user._id }, { read: true });
  ok(res, { success: true });
});

exports.markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, read: false, ...PROPERTY_ONLY }, { read: true });
  ok(res, { success: true });
});

exports.unreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.countDocuments({ userId: req.user._id, read: false, ...PROPERTY_ONLY });
  ok(res, count);
});
