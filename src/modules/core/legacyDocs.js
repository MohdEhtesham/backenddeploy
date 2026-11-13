const { registry } = require('./openapi');
const { z } = require('zod');
const v = require('../../validators/auth');

// The marketplace predates the route builder; register its endpoints so
// the OpenAPI document covers the whole API surface.
const LEGACY = [
  // Auth (shared by both products)
  ['post', '/auth/signup', 'Auth', 'Create an account', 'public', v.signupSchema],
  ['post', '/auth/login', 'Auth', 'Sign in (email/phone + password). Send `X-Auth-Mode: refresh` for short-lived access + refresh tokens.', 'public', v.loginSchema],
  ['post', '/auth/otp/send', 'Auth', 'Send a login OTP (rate limited, hashed, expiring)', 'public', v.otpRequestSchema],
  ['post', '/auth/otp/verify', 'Auth', 'Verify OTP and sign in', 'public', v.otpVerifySchema],
  ['post', '/auth/refresh', 'Auth', 'Rotate refresh token → new access token (reuse detection)', 'public', v.refreshSchema],
  ['post', '/auth/forgot-password', 'Auth', 'Request a password reset', 'public', v.forgotSchema],
  ['get', '/auth/me', 'Auth', 'Current user', 'user'],
  ['delete', '/auth/me', 'Auth', 'Delete my account', 'user'],
  ['post', '/auth/logout', 'Auth', 'Sign out (revokes this session)', 'user', z.object({ refreshToken: z.string().optional(), deviceToken: z.string().optional() })],
  ['post', '/auth/logout-all', 'Auth', 'Sign out everywhere', 'user'],
  ['get', '/auth/sessions', 'Auth', 'My active sessions', 'user'],
  ['delete', '/auth/sessions/:id', 'Auth', 'Revoke a session', 'user'],
  ['put', '/auth/profile', 'Auth', 'Update profile', 'user'],
  ['put', '/auth/role', 'Auth', 'Switch marketplace role (consumer / seller)', 'user'],
  ['put', '/auth/seller/plan', 'Auth', 'Set seller listing plan', 'user'],
  // Marketplace
  ['get', '/properties', 'Marketplace', 'Browse listings (filters, paging)', 'public'],
  ['get', '/properties/featured', 'Marketplace', 'Featured listings', 'public'],
  ['get', '/properties/trending', 'Marketplace', 'Trending listings', 'public'],
  ['get', '/properties/recommended', 'Marketplace', 'Recommended listings', 'public'],
  ['get', '/properties/search', 'Marketplace', 'Search listings', 'public'],
  ['get', '/properties/saved', 'Marketplace', 'My saved listings', 'user'],
  ['post', '/properties/:id/save', 'Marketplace', 'Save / unsave a listing', 'user'],
  ['get', '/properties/:id/similar', 'Marketplace', 'Similar listings', 'public'],
  ['get', '/properties/:id', 'Marketplace', 'Listing detail', 'public'],
  ['get', '/inquiries', 'Marketplace', 'My inquiries', 'user'],
  ['post', '/inquiries', 'Marketplace', 'Send an inquiry', 'user'],
  ['get', '/inquiries/:id', 'Marketplace', 'Inquiry detail', 'user'],
  ['get', '/visits', 'Marketplace', 'My site visits', 'user'],
  ['get', '/visits/slots', 'Marketplace', 'Available visit slots', 'user'],
  ['post', '/visits', 'Marketplace', 'Book a site visit', 'user'],
  ['get', '/visits/:id', 'Marketplace', 'Visit detail', 'user'],
  ['put', '/visits/:id/cancel', 'Marketplace', 'Cancel a visit', 'user'],
  ['put', '/visits/:id/reschedule', 'Marketplace', 'Reschedule a visit', 'user'],
  ['get', '/notifications', 'Marketplace', 'Marketplace notifications', 'user'],
  ['get', '/notifications/unread-count', 'Marketplace', 'Unread count', 'user'],
  ['put', '/notifications/:id/read', 'Marketplace', 'Mark read', 'user'],
  ['put', '/notifications/read-all', 'Marketplace', 'Mark all read', 'user'],
  ['get', '/chat/threads', 'Marketplace', 'Chat threads', 'user'],
  ['post', '/chat/threads', 'Marketplace', 'Open a chat with a seller', 'user'],
  ['get', '/chat/threads/:id', 'Marketplace', 'Thread with messages', 'user'],
  ['post', '/chat/threads/:id/messages', 'Marketplace', 'Send a message', 'user'],
  ['post', '/chat/threads/:id/read', 'Marketplace', 'Mark thread read', 'user'],
  ['get', '/seller/listings', 'Marketplace seller', 'My listings', 'user'],
  ['post', '/seller/listings', 'Marketplace seller', 'Create a listing', 'user'],
  ['get', '/seller/listings/:id', 'Marketplace seller', 'Listing detail', 'user'],
  ['put', '/seller/listings/:id', 'Marketplace seller', 'Update a listing', 'user'],
  ['put', '/seller/listings/:id/status', 'Marketplace seller', 'Change listing status', 'user'],
  ['delete', '/seller/listings/:id', 'Marketplace seller', 'Delete a listing', 'user'],
  ['get', '/seller/leads', 'Marketplace seller', 'Leads', 'user'],
  ['put', '/seller/leads/:id/status', 'Marketplace seller', 'Update lead status', 'user'],
  ['get', '/seller/visits', 'Marketplace seller', 'Visits on my listings', 'user'],
  ['put', '/seller/visits/:id/status', 'Marketplace seller', 'Update visit status', 'user'],
  ['get', '/seller/analytics', 'Marketplace seller', 'Seller analytics', 'user'],
  ['post', '/uploads/single', 'Uploads', 'Upload one public image (Cloudinary)', 'user'],
  ['post', '/uploads/multiple', 'Uploads', 'Upload up to 10 public images', 'user'],
  ['get', '/admin/dashboard', 'Marketplace admin', 'Marketplace admin dashboard', 'user'],
  // Platform
  ['post', '/webhooks/razorpay', 'Payments', 'Razorpay webhook (HMAC-verified, idempotent by event id)', 'public'],
  ['get', '/payments/return', 'Payments', 'Checkout return page → verifies with the gateway → deep link back to the app', 'public'],
  ['post', '/internal/jobs/:name', 'Jobs', 'Run a scheduled job (X-Cron-Secret header; disabled unless CRON_SECRET is set)', 'public'],
];

let registered = false;

const registerLegacyDocs = () => {
  if (registered) return;
  registered = true;
  for (const [method, path, tag, summary, auth, body] of LEGACY) {
    registry.add({ method, path, tag, summary, auth, body, write: method !== 'get' });
  }
};

module.exports = { registerLegacyDocs };
