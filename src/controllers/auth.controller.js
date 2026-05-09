const User = require('../models/User');
const { signToken } = require('../utils/jwt');
const { ok, created, ApiError } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');

function quotaForPlan(plan) {
  return { free: 1, basic: 10, pro: 999 }[plan] ?? 1;
}

exports.signup = asyncHandler(async (req, res) => {
  const { fullName, email, phone, password, role = 'consumer' } = req.body;

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw new ApiError(409, 'Email already registered');

  const user = new User({
    fullName,
    email,
    phone,
    role,
    seller: { plan: 'free', listingQuotaUsed: 0, listingQuotaTotal: 1, totalLeads: 0, rating: 0 },
  });
  await user.setPassword(password);
  await user.save();

  const token = signToken({ sub: user._id.toString(), role: user.role });
  created(res, { user: user.toPublic(), token });
});

exports.login = asyncHandler(async (req, res) => {
  const { identifier, password, role } = req.body;

  const isEmail = identifier.includes('@');
  const query = isEmail ? { email: identifier.toLowerCase() } : { phone: identifier };
  const user = await User.findOne(query).select('+passwordHash');
  if (!user) throw new ApiError(401, 'Invalid credentials');

  const okPass = await user.checkPassword(password);
  if (!okPass) throw new ApiError(401, 'Invalid credentials');

  // Mirror frontend role-tab UX: if user picks a role on login, switch into it
  if (role && role !== user.role) {
    user.role = role;
    if (role === 'seller' && !user.seller?.plan) {
      user.seller = { plan: 'free', listingQuotaUsed: 0, listingQuotaTotal: 1, totalLeads: 0, rating: 0 };
    }
    await user.save();
  }

  const token = signToken({ sub: user._id.toString(), role: user.role });
  ok(res, { user: user.toPublic(), token });
});

// MOCK OTP — always succeeds with 1234. Replace with real SMS provider later.
exports.sendOtp = asyncHandler(async (_req, res) => {
  ok(res, { sent: true, otp: '1234' }, 'OTP sent (mock — use 1234)');
});

exports.verifyOtp = asyncHandler(async (req, res) => {
  const { phone, otp, role = 'consumer' } = req.body;
  if (otp !== '1234') throw new ApiError(401, 'Invalid OTP');

  let user = await User.findOne({ phone });
  if (!user) {
    // Auto-create a minimal account for OTP-only flow
    user = new User({
      fullName: 'New User',
      email: `${phone}@aabroo.app`,
      phone,
      role,
      seller: { plan: 'free', listingQuotaUsed: 0, listingQuotaTotal: 1, totalLeads: 0, rating: 0 },
    });
    await user.setPassword(Math.random().toString(36).slice(2));
    await user.save();
  } else if (role && role !== user.role) {
    user.role = role;
    await user.save();
  }

  const token = signToken({ sub: user._id.toString(), role: user.role });
  ok(res, { valid: true, user: user.toPublic(), token });
});

exports.forgotPassword = asyncHandler(async (_req, res) => {
  // Stub — connect a real email/SMS provider in production
  ok(res, { sent: true });
});

exports.me = asyncHandler(async (req, res) => {
  ok(res, req.user.toPublic());
});

exports.logout = asyncHandler(async (_req, res) => {
  ok(res, { success: true });
});

exports.updateProfile = asyncHandler(async (req, res) => {
  const allowed = ['fullName', 'email', 'phone', 'avatar', 'city', 'preferences'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) req.user[key] = req.body[key];
  }
  await req.user.save();
  ok(res, req.user.toPublic());
});

exports.setRole = asyncHandler(async (req, res) => {
  const role = req.body.role;
  if (!['consumer', 'seller'].includes(role)) throw new ApiError(400, 'Invalid role');
  req.user.role = role;
  if (role === 'seller' && !req.user.seller?.plan) {
    req.user.seller = { plan: 'free', listingQuotaUsed: 0, listingQuotaTotal: 1, totalLeads: 0, rating: 0 };
  }
  await req.user.save();
  ok(res, req.user.toPublic());
});

exports.deleteAccount = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  // Cascade-delete all data owned by this user.
  // Lazy-required to avoid circular imports.
  const Inquiry = require('../models/Inquiry');
  const Visit = require('../models/Visit');
  const Lead = require('../models/Lead');
  const Notification = require('../models/Notification');
  const ChatThread = require('../models/ChatThread');
  const Property = require('../models/Property');

  await Promise.all([
    Inquiry.deleteMany({ consumerId: userId }),
    Visit.deleteMany({ consumerId: userId }),
    Lead.deleteMany({ sellerId: userId }),
    Notification.deleteMany({ userId }),
    ChatThread.deleteMany({ userId }),
    // Only seller-uploaded listings — never touch curated catalog
    Property.deleteMany({ ownerId: userId, isUserListing: true }),
  ]);

  await req.user.deleteOne();

  ok(res, { success: true });
});

exports.setSellerPlan = asyncHandler(async (req, res) => {
  const plan = req.body.plan;
  if (!['free', 'basic', 'pro'].includes(plan)) throw new ApiError(400, 'Invalid plan');
  if (!req.user.seller) req.user.seller = {};
  req.user.seller.plan = plan;
  req.user.seller.listingQuotaTotal = quotaForPlan(plan);
  const expires = new Date();
  expires.setMonth(expires.getMonth() + 1);
  req.user.seller.planExpiresAt = expires;
  await req.user.save();
  ok(res, req.user.toPublic());
});
