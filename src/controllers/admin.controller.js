// Admin controller — full CRUD over every entity in the system, plus a
// dashboard aggregate for the admin web app's landing page.
//
// All routes here are gated by authRequired + roleRequired('admin') in
// admin.routes.js. Operations are intentionally NOT scoped by ownership
// (unlike /seller/*) — the admin can act on any document.

const User = require('../models/User');
const Property = require('../models/Property');
const Lead = require('../models/Lead');
const Visit = require('../models/Visit');
const Inquiry = require('../models/Inquiry');
const Notification = require('../models/Notification');
const ChatThread = require('../models/ChatThread');
const { ok, ApiError } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');

// Shared helpers --------------------------------------------------------------

const parsePaging = req => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(5, parseInt(req.query.pageSize, 10) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize, limit: pageSize };
};

// Build a Mongo $or text search clause on the supplied fields.
const buildSearch = (q, fields) => {
  if (!q || typeof q !== 'string') return {};
  const safe = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!safe) return {};
  const re = new RegExp(safe, 'i');
  return { $or: fields.map(f => ({ [f]: re })) };
};

const wrapList = (items, total, page, pageSize) => ({
  items,
  total,
  page,
  pageSize,
  hasMore: page * pageSize < total,
});

// Dashboard -------------------------------------------------------------------

exports.dashboard = asyncHandler(async (_req, res) => {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    consumers,
    sellers,
    suspended,
    newUsers30d,
    totalListings,
    liveListings,
    newListings30d,
    totalLeads,
    newLeads24h,
    totalVisits,
    upcomingVisits,
    totalInquiries,
    newInquiries24h,
    activeChats,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ role: 'consumer' }),
    User.countDocuments({ role: 'seller' }),
    User.countDocuments({ suspended: true }),
    User.countDocuments({ createdAt: { $gte: since30d } }),
    Property.countDocuments({}),
    Property.countDocuments({ status: 'live' }),
    Property.countDocuments({ createdAt: { $gte: since30d } }),
    Lead.countDocuments({}),
    Lead.countDocuments({ createdAt: { $gte: since24h } }),
    Visit.countDocuments({}),
    Visit.countDocuments({ status: 'upcoming' }),
    Inquiry.countDocuments({}),
    Inquiry.countDocuments({ createdAt: { $gte: since24h } }),
    ChatThread.countDocuments({}),
  ]);

  ok(res, {
    users: { total: totalUsers, consumers, sellers, suspended, new30d: newUsers30d },
    listings: { total: totalListings, live: liveListings, new30d: newListings30d },
    leads: { total: totalLeads, new24h: newLeads24h },
    visits: { total: totalVisits, upcoming: upcomingVisits },
    inquiries: { total: totalInquiries, new24h: newInquiries24h },
    chats: { total: activeChats },
  });
});

// Users -----------------------------------------------------------------------

exports.listUsers = asyncHandler(async (req, res) => {
  const { page, pageSize, skip, limit } = parsePaging(req);
  const filter = {};
  if (req.query.role && ['consumer', 'seller', 'admin'].includes(req.query.role)) {
    filter.role = req.query.role;
  }
  if (req.query.suspended === 'true') filter.suspended = true;
  if (req.query.suspended === 'false') filter.suspended = false;
  Object.assign(filter, buildSearch(req.query.q, ['fullName', 'email', 'phone', 'city']));

  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  ok(res, wrapList(items.map(u => u.toPublic()), total, page, pageSize));
});

exports.getUser = asyncHandler(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) throw new ApiError(404, 'User not found');
  ok(res, u.toPublic());
});

exports.updateUser = asyncHandler(async (req, res) => {
  // Whitelist what can be edited via admin to avoid accidentally clobbering
  // sensitive fields. Password reset is intentionally NOT exposed here —
  // route that through a dedicated reset endpoint with email confirmation.
  const allowed = ['fullName', 'email', 'phone', 'city', 'role', 'avatar', 'suspended'];
  const patch = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (patch.role && !['consumer', 'seller', 'admin'].includes(patch.role)) {
    throw new ApiError(400, 'Invalid role');
  }
  if (req.body.seller && typeof req.body.seller === 'object') {
    patch.seller = req.body.seller;
  }
  const u = await User.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
  if (!u) throw new ApiError(404, 'User not found');
  ok(res, u.toPublic());
});

exports.deleteUser = asyncHandler(async (req, res) => {
  const userId = req.params.id;
  if (String(req.user._id) === String(userId)) {
    throw new ApiError(400, 'You cannot delete your own admin account');
  }
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found');

  // Cascade: blow away anything tied to this user. Mirror the behavior of
  // the consumer-side deleteAccount endpoint so admin deletion is no
  // softer than a self-delete.
  await Promise.all([
    Inquiry.deleteMany({ consumerId: userId }),
    Visit.deleteMany({ consumerId: userId }),
    Lead.deleteMany({ $or: [{ sellerId: userId }, { consumerId: userId }] }),
    Notification.deleteMany({ userId }),
    ChatThread.deleteMany({ userId }),
    Property.deleteMany({ ownerId: userId, isUserListing: true }),
  ]);

  await User.findByIdAndDelete(userId);
  ok(res, { success: true });
});

// Listings (Property) ---------------------------------------------------------

exports.listListings = asyncHandler(async (req, res) => {
  const { page, pageSize, skip, limit } = parsePaging(req);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.city) filter.city = req.query.city;
  if (req.query.isUserListing === 'true') filter.isUserListing = true;
  if (req.query.isUserListing === 'false') filter.isUserListing = false;
  Object.assign(filter, buildSearch(req.query.q, ['title', 'builder', 'locality', 'city']));

  const [items, total] = await Promise.all([
    Property.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Property.countDocuments(filter),
  ]);
  ok(res, wrapList(items.map(i => i.toPublic()), total, page, pageSize));
});

exports.getListing = asyncHandler(async (req, res) => {
  const item = await Property.findById(req.params.id);
  if (!item) throw new ApiError(404, 'Listing not found');
  ok(res, item.toPublic());
});

exports.updateListing = asyncHandler(async (req, res) => {
  const item = await Property.findByIdAndUpdate(
    req.params.id,
    { $set: req.body },
    { new: true },
  );
  if (!item) throw new ApiError(404, 'Listing not found');
  ok(res, item.toPublic());
});

exports.deleteListing = asyncHandler(async (req, res) => {
  const item = await Property.findByIdAndDelete(req.params.id);
  if (!item) throw new ApiError(404, 'Listing not found');
  ok(res, { success: true });
});

// Leads -----------------------------------------------------------------------

exports.listLeads = asyncHandler(async (req, res) => {
  const { page, pageSize, skip, limit } = parsePaging(req);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  Object.assign(
    filter,
    buildSearch(req.query.q, ['consumerName', 'consumerEmail', 'consumerPhone', 'listingTitle']),
  );
  const [items, total] = await Promise.all([
    Lead.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Lead.countDocuments(filter),
  ]);
  ok(res, wrapList(items.map(l => l.toPublic()), total, page, pageSize));
});

exports.getLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) throw new ApiError(404, 'Lead not found');
  ok(res, lead.toPublic());
});

exports.deleteLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findByIdAndDelete(req.params.id);
  if (!lead) throw new ApiError(404, 'Lead not found');
  ok(res, { success: true });
});

// Visits ----------------------------------------------------------------------

exports.listVisits = asyncHandler(async (req, res) => {
  const { page, pageSize, skip, limit } = parsePaging(req);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.mode) filter.mode = req.query.mode;
  Object.assign(filter, buildSearch(req.query.q, ['propertyTitle', 'propertyLocation']));
  const [items, total] = await Promise.all([
    Visit.find(filter)
      .populate('consumerId', 'fullName phone email')
      .populate('propertyOwnerId', 'fullName phone email')
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit),
    Visit.countDocuments(filter),
  ]);
  ok(res, wrapList(items.map(v => v.toObject()), total, page, pageSize));
});

exports.getVisit = asyncHandler(async (req, res) => {
  const v = await Visit.findById(req.params.id)
    .populate('consumerId', 'fullName phone email')
    .populate('propertyOwnerId', 'fullName phone email');
  if (!v) throw new ApiError(404, 'Visit not found');
  ok(res, v.toObject());
});

exports.deleteVisit = asyncHandler(async (req, res) => {
  const v = await Visit.findByIdAndDelete(req.params.id);
  if (!v) throw new ApiError(404, 'Visit not found');
  ok(res, { success: true });
});

// Inquiries -------------------------------------------------------------------

exports.listInquiries = asyncHandler(async (req, res) => {
  const { page, pageSize, skip, limit } = parsePaging(req);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  Object.assign(filter, buildSearch(req.query.q, ['fullName', 'email', 'phone', 'propertyTitle']));
  const [items, total] = await Promise.all([
    Inquiry.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Inquiry.countDocuments(filter),
  ]);
  ok(res, wrapList(items.map(i => i.toPublic()), total, page, pageSize));
});

exports.getInquiry = asyncHandler(async (req, res) => {
  const i = await Inquiry.findById(req.params.id);
  if (!i) throw new ApiError(404, 'Inquiry not found');
  ok(res, i.toPublic());
});

exports.deleteInquiry = asyncHandler(async (req, res) => {
  const i = await Inquiry.findByIdAndDelete(req.params.id);
  if (!i) throw new ApiError(404, 'Inquiry not found');
  ok(res, { success: true });
});

// Notifications ---------------------------------------------------------------

exports.listNotifications = asyncHandler(async (req, res) => {
  const { page, pageSize, skip, limit } = parsePaging(req);
  const filter = {};
  if (req.query.type) filter.type = req.query.type;
  if (req.query.read === 'true') filter.read = true;
  if (req.query.read === 'false') filter.read = false;
  Object.assign(filter, buildSearch(req.query.q, ['title', 'body']));
  const [items, total] = await Promise.all([
    Notification.find(filter)
      .populate('userId', 'fullName email role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Notification.countDocuments(filter),
  ]);
  ok(res, wrapList(items.map(n => n.toObject()), total, page, pageSize));
});

exports.deleteNotification = asyncHandler(async (req, res) => {
  const n = await Notification.findByIdAndDelete(req.params.id);
  if (!n) throw new ApiError(404, 'Notification not found');
  ok(res, { success: true });
});
