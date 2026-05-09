const Notification = require('../models/Notification');
const { ok } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');

exports.list = asyncHandler(async (req, res) => {
  const items = await Notification.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100);
  ok(res, items.map(i => i.toPublic()));
});

exports.markRead = asyncHandler(async (req, res) => {
  await Notification.updateOne({ _id: req.params.id, userId: req.user._id }, { read: true });
  ok(res, { success: true });
});

exports.markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, read: false }, { read: true });
  ok(res, { success: true });
});

exports.unreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.countDocuments({ userId: req.user._id, read: false });
  ok(res, count);
});
