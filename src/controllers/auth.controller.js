const User = require('../models/User');
const { ok, created, ApiError } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');
const tokens = require('../modules/auth/tokens');
const otpService = require('../modules/auth/otpService');

function quotaForPlan(plan) {
  return { free: 1, basic: 10, pro: 999 }[plan] ?? 1;
}

const FREE_SELLER = { plan: 'free', listingQuotaUsed: 0, listingQuotaTotal: 1, totalLeads: 0, rating: 0 };

/**
 * The login "I am a buyer / seller" tab switches the marketplace role — but
 * only when the client explicitly sends one (the PG app doesn't), and never
 * for platform admins, who would otherwise silently lose admin access.
 */
async function applyRequestedRole(user, role) {
  if (!role || role === user.role || user.role === 'admin') return;
  user.role = role;
  if (role === 'seller' && !user.seller?.plan) user.seller = { ...FREE_SELLER };
  await user.save();
}

/** Legacy `{ user, token }` plus refresh-token fields for newer clients. */
async function authPayload(user, req, extra = {}) {
  const session = await tokens.issueSession(user, req);
  return {
    ...extra,
    user: user.toPublic(),
    token: session.token,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshToken: session.refreshToken,
  };
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
    seller: { ...FREE_SELLER },
  });
  await user.setPassword(password);
  await user.save();

  created(res, await authPayload(user, req));
});

exports.login = asyncHandler(async (req, res) => {
  const { identifier, password, role } = req.body;

  const isEmail = identifier.includes('@');
  const query = isEmail ? { email: identifier.toLowerCase() } : { phone: identifier };
  const user = await User.findOne(query).select('+passwordHash');
  if (!user) throw new ApiError(401, 'Invalid credentials');

  const okPass = await user.checkPassword(password);
  if (!okPass) throw new ApiError(401, 'Invalid credentials');
  if (user.suspended) throw new ApiError(403, 'This account has been suspended.');

  await applyRequestedRole(user, role);

  ok(res, await authPayload(user, req));
});

exports.sendOtp = asyncHandler(async (req, res) => {
  const result = await otpService.sendOtp(req.body.phone, { ip: req.ip });
  ok(res, result, result.otp ? `OTP sent (demo mode — use ${result.otp})` : 'OTP sent');
});

exports.verifyOtp = asyncHandler(async (req, res) => {
  const { phone, otp, role } = req.body;
  await otpService.verifyOtp(phone, otp);

  let user = await User.findOne({ phone });
  if (!user) {
    // Auto-create a minimal account for OTP-only flow
    user = new User({
      fullName: 'New User',
      email: `${phone}@aabroo.app`,
      phone,
      role: role || 'consumer',
      seller: { ...FREE_SELLER },
    });
    await user.setPassword(require('crypto').randomBytes(24).toString('base64url'));
    await user.save();
  } else {
    if (user.suspended) throw new ApiError(403, 'This account has been suspended.');
    await applyRequestedRole(user, role);
  }

  ok(res, await authPayload(user, req, { valid: true }));
});

exports.refresh = asyncHandler(async (req, res) => {
  const result = await tokens.rotateRefreshToken(req.body.refreshToken);
  ok(res, {
    user: result.user.toPublic(),
    token: result.token,
    accessTokenExpiresAt: result.accessTokenExpiresAt,
    refreshToken: result.refreshToken,
  });
});

exports.forgotPassword = asyncHandler(async (_req, res) => {
  // Stub — connect a real email/SMS provider in production
  ok(res, { sent: true });
});

exports.me = asyncHandler(async (req, res) => {
  ok(res, req.user.toPublic());
});

exports.logout = asyncHandler(async (req, res) => {
  if (req.auth?.sessionId) await tokens.revokeSession(req.auth.sessionId, 'logout');
  // Clients may also pass their refresh token to end that session.
  const rt = req.body && typeof req.body.refreshToken === 'string' ? req.body.refreshToken : '';
  const sid = rt.includes('.') ? rt.slice(0, rt.indexOf('.')) : '';
  if (sid) {
    const owned = (await tokens.listSessions(req.user._id)).some(s => String(s._id) === sid);
    if (owned) await tokens.revokeSession(sid, 'logout');
  }
  // Stop pushing to this device once signed out.
  const deviceToken = req.body && typeof req.body.deviceToken === 'string' ? req.body.deviceToken : '';
  if (deviceToken) {
    const DeviceToken = require('../modules/notifications/DeviceToken');
    await DeviceToken.deleteOne({ token: deviceToken, userId: req.user._id });
  }
  ok(res, { success: true });
});

exports.logoutAll = asyncHandler(async (req, res) => {
  await tokens.revokeAllSessions(req.user._id, 'logout_all');
  ok(res, { success: true });
});

exports.sessions = asyncHandler(async (req, res) => {
  const rows = await tokens.listSessions(req.user._id);
  ok(
    res,
    rows.map(s => ({
      id: s._id,
      userAgent: s.userAgent,
      platform: s.platform,
      lastUsedAt: s.lastUsedAt,
      createdAt: s.createdAt,
      current: String(s._id) === String(req.auth?.sessionId || ''),
    })),
  );
});

exports.revokeSession = asyncHandler(async (req, res) => {
  const rows = await tokens.listSessions(req.user._id);
  if (!rows.some(s => String(s._id) === req.params.id)) throw new ApiError(404, 'Session not found');
  await tokens.revokeSession(req.params.id, 'revoked_by_user');
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
  if (req.user.role === 'admin') throw new ApiError(400, 'Admin accounts cannot switch role');
  req.user.role = role;
  if (role === 'seller' && !req.user.seller?.plan) {
    req.user.seller = { ...FREE_SELLER };
  }
  await req.user.save();
  ok(res, req.user.toPublic());
});

exports.deleteAccount = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  // Lazy-required to avoid circular imports.
  const Inquiry = require('../models/Inquiry');
  const Visit = require('../models/Visit');
  const Lead = require('../models/Lead');
  const Notification = require('../models/Notification');
  const ChatThread = require('../models/ChatThread');
  const Property = require('../models/Property');
  const OrganizationUser = require('../modules/saas/models/OrganizationUser');
  const DeviceToken = require('../modules/notifications/DeviceToken');
  const Tenant = require('../modules/pg/models/Tenant');
  const { unscoped } = require('../modules/core/scope');

  // A PG organization must never be left without an owner.
  const ownerships = await unscoped(() =>
    OrganizationUser.countDocuments({ userId, role: 'OWNER', status: 'ACTIVE' }),
  );
  if (ownerships > 0) {
    throw new ApiError(
      409,
      'You own a PG organization. Transfer ownership or close the organization before deleting your account.',
    );
  }

  // Cascade-delete all data owned by this user.
  await Promise.all([
    Inquiry.deleteMany({ consumerId: userId }),
    Visit.deleteMany({ consumerId: userId }),
    Lead.deleteMany({ sellerId: userId }),
    Notification.deleteMany({ userId }),
    ChatThread.deleteMany({ userId }),
    // Only seller-uploaded listings — never touch curated catalog
    Property.deleteMany({ ownerId: userId, isUserListing: true }),
    DeviceToken.deleteMany({ userId }),
    tokens.revokeAllSessions(userId, 'account_deleted'),
    // PG records belong to the organization; only unlink the login.
    unscoped(() => OrganizationUser.deleteMany({ userId })),
    unscoped(() => Tenant.updateMany({ userId }, { $set: { userId: null } })),
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
