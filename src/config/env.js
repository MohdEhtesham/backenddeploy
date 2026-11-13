// Tests pin every variable they need; never let a developer's local .env
// (real DB URI, payment keys…) leak into a test run.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config(process.env.ENV_FILE ? { path: process.env.ENV_FILE } : undefined);
}

const NODE_ENV = process.env.NODE_ENV || 'development';

// APP_ENV selects the deployment tier (development | staging | production).
// It is separate from NODE_ENV because the current Render test deployment
// runs NODE_ENV=production while really being a staging environment; strict
// production-only checks key off APP_ENV so that deployment keeps booting.
const APP_ENV = (() => {
  const v = (process.env.APP_ENV || '').toLowerCase();
  if (['development', 'staging', 'production', 'test'].includes(v)) return v;
  if (NODE_ENV === 'test') return 'test';
  return NODE_ENV === 'production' ? 'staging' : 'development';
})();
const IS_PROD = APP_ENV === 'production';

const str = (key, fallback = '') => {
  const v = process.env[key];
  return v === undefined || v === null || v === '' ? fallback : String(v);
};
const int = (key, fallback) => {
  const n = parseInt(process.env[key], 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const list = (key, fallback = '') =>
  str(key, fallback)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// Accept either MONGODB_URI or MONGO_URI (different conventions across hosts)
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const PORT = int('PORT', 4000);

// Cloudinary creds — uploads endpoint will gracefully disable if missing
const CLOUDINARY = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
  api_key: process.env.CLOUDINARY_API_KEY || '',
  api_secret: process.env.CLOUDINARY_API_SECRET || '',
};
const CLOUDINARY_ENABLED = Boolean(
  CLOUDINARY.cloud_name && CLOUDINARY.api_key && CLOUDINARY.api_secret,
);

// Render injects RENDER_EXTERNAL_URL; used for payment return URLs and
// signed file links when PUBLIC_API_URL isn't set explicitly.
const PUBLIC_API_URL = str(
  'PUBLIC_API_URL',
  str('RENDER_EXTERNAL_URL', `http://localhost:${PORT}`),
).replace(/\/+$/, '');

const RAZORPAY = {
  keyId: str('RAZORPAY_KEY_ID'),
  keySecret: str('RAZORPAY_KEY_SECRET'),
  webhookSecret: str('RAZORPAY_WEBHOOK_SECRET'),
};

const OTP_MODE = (() => {
  const v = str('OTP_MODE').toLowerCase();
  if (v === 'fixed' || v === 'random') return v;
  // Keeps the existing demo flow (OTP 1234) working on dev/staging until an
  // SMS provider is configured; production always sends random codes.
  return IS_PROD ? 'random' : 'fixed';
})();

const config = {
  NODE_ENV,
  APP_ENV,
  IS_PROD,
  PORT,
  MONGODB_URI,
  JWT_SECRET: JWT_SECRET || 'dev-secret-change-me-in-production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '30d',
  CORS_ORIGINS: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  CLOUDINARY,
  CLOUDINARY_ENABLED,
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX, 10) || 300,

  // ---- Auth / sessions ----------------------------------------------------
  // Short-lived access tokens for clients that implement refresh
  // (X-Auth-Mode: refresh). Legacy clients keep JWT_EXPIRES_IN.
  ACCESS_TOKEN_TTL: str('ACCESS_TOKEN_TTL', '1h'),
  REFRESH_TOKEN_TTL_DAYS: int('REFRESH_TOKEN_TTL_DAYS', 30),
  SESSION_MAX_AGE_DAYS: int('SESSION_MAX_AGE_DAYS', 90),
  AUTH_RATE_LIMIT_MAX: int('AUTH_RATE_LIMIT_MAX', 30),

  OTP_MODE,
  OTP_FIXED_CODE: str('OTP_FIXED_CODE', '1234'),
  OTP_LENGTH: int('OTP_LENGTH', 4),
  OTP_TTL_SECONDS: int('OTP_TTL_SECONDS', 300),
  OTP_MAX_ATTEMPTS: int('OTP_MAX_ATTEMPTS', 5),
  OTP_RESEND_COOLDOWN_SECONDS: int('OTP_RESEND_COOLDOWN_SECONDS', 30),
  OTP_MAX_SENDS_PER_HOUR: int('OTP_MAX_SENDS_PER_HOUR', 5),
  OTP_DEV_ECHO: bool('OTP_DEV_ECHO', APP_ENV === 'development' || APP_ENV === 'test'),

  PUBLIC_API_URL,
  APP_SCHEME: str('APP_SCHEME', 'abroo'),
  APP_LINK_HOSTS: list('APP_LINK_HOSTS', 'abroo.app,www.abroo.app'),
  ANDROID_PACKAGE: str('ANDROID_PACKAGE', 'com.aoccrmconnect'),
  ANDROID_SHA256_CERT_FINGERPRINTS: list('ANDROID_SHA256_CERT_FINGERPRINTS'),
  IOS_APP_IDS: list('IOS_APP_IDS'),

  API_DOCS_ENABLED: bool('API_DOCS_ENABLED', !IS_PROD),

  // ---- Payments -----------------------------------------------------------
  RAZORPAY,
  ONLINE_PAYMENTS_ENABLED: Boolean(RAZORPAY.keyId && RAZORPAY.keySecret && RAZORPAY.webhookSecret),
  PAYMENT_LINK_EXPIRY_MINUTES: int('PAYMENT_LINK_EXPIRY_MINUTES', 60 * 24),

  // ---- Private document storage ------------------------------------------
  STORAGE_DRIVER: str('STORAGE_DRIVER', CLOUDINARY_ENABLED && APP_ENV !== 'development' && APP_ENV !== 'test' ? 'cloudinary' : 'local'),
  LOCAL_STORAGE_DIR: str('LOCAL_STORAGE_DIR', require('path').join(__dirname, '..', '..', 'storage', 'private')),
  FILE_URL_SECRET: str('FILE_URL_SECRET', `${JWT_SECRET || 'dev-secret'}:files`),
  SIGNED_URL_TTL_SECONDS: int('SIGNED_URL_TTL_SECONDS', 600),
  MAX_UPLOAD_MB: int('MAX_UPLOAD_MB', 8),

  // ---- Notification channels ---------------------------------------------
  PUSH_PROVIDER: str('PUSH_PROVIDER', 'console'),
  FCM: {
    projectId: str('FCM_PROJECT_ID'),
    clientEmail: str('FCM_CLIENT_EMAIL'),
    privateKey: str('FCM_PRIVATE_KEY').replace(/\\n/g, '\n'),
  },
  SMS_PROVIDER: str('SMS_PROVIDER', 'console'),
  TWILIO: {
    accountSid: str('TWILIO_ACCOUNT_SID'),
    authToken: str('TWILIO_AUTH_TOKEN'),
    from: str('TWILIO_FROM'),
  },
  MSG91: {
    authKey: str('MSG91_AUTH_KEY'),
    templateId: str('MSG91_TEMPLATE_ID'),
    otpTemplateId: str('MSG91_OTP_TEMPLATE_ID'),
  },
  EMAIL_PROVIDER: str('EMAIL_PROVIDER', 'console'),
  EMAIL_API_KEY: str('EMAIL_API_KEY'),
  EMAIL_FROM: str('EMAIL_FROM', 'Aabroo <no-reply@abroo.app>'),
  WHATSAPP_PROVIDER: str('WHATSAPP_PROVIDER', 'console'),
  WHATSAPP: {
    token: str('WHATSAPP_TOKEN'),
    phoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID'),
  },

  // ---- SaaS defaults (seed PlatformSetting; super admin can edit live) ----
  SAAS_TRIAL_DAYS: int('SAAS_TRIAL_DAYS', 14),
  SAAS_TRIAL_PLAN: str('SAAS_TRIAL_PLAN', 'BUSINESS'),
  SAAS_GRACE_DAYS: int('SAAS_GRACE_DAYS', 7),
  SAAS_TRIAL_EXPIRY_ACTION: str('SAAS_TRIAL_EXPIRY_ACTION', 'EXPIRE'),

  // ---- Marketplace --------------------------------------------------------
  // Seller listing limits per plan (free = 1 listing). Off for now: every
  // seller can post unlimited listings. Set to true to enforce plans again.
  LISTING_QUOTA_ENFORCED: bool('LISTING_QUOTA_ENFORCED', false),

  // ---- Jobs ---------------------------------------------------------------
  JOBS_ENABLED: bool('JOBS_ENABLED', APP_ENV !== 'test'),
  JOBS_INTERVAL_MINUTES: int('JOBS_INTERVAL_MINUTES', 60),
  CRON_SECRET: str('CRON_SECRET'),

  ANALYTICS_RETENTION_DAYS: int('ANALYTICS_RETENTION_DAYS', 180),
  DEFAULT_TIMEZONE: str('DEFAULT_TIMEZONE', 'Asia/Kolkata'),
};

// Friendly, loud startup diagnostics. Production refuses to boot with an
// unsafe configuration; other tiers only warn.
function checkConfig() {
  if (APP_ENV === 'test') return;
  const missing = [];
  if (!MONGODB_URI) missing.push('MONGODB_URI (or MONGO_URI)');
  if (!JWT_SECRET) missing.push('JWT_SECRET');

  if (missing.length) {
    console.error('');
    console.error('============================================================');
    console.error('[env] Missing required environment variables:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('');
    console.error('Set them in your hosting dashboard (Render → Environment).');
    console.error('Locally, copy backend/.env.example to backend/.env and fill in.');
    console.error('============================================================');
    console.error('');
  }

  if (!CLOUDINARY_ENABLED) {
    console.warn(
      '[env] Cloudinary creds not set — image upload endpoints will return 503. ' +
        'Other features still work.',
    );
  }

  const problems = [];
  if (IS_PROD) {
    if (JWT_SECRET.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
    if (config.OTP_MODE === 'fixed') problems.push('OTP_MODE=fixed is not allowed in production');
    if (config.STORAGE_DRIVER === 'local') {
      problems.push('STORAGE_DRIVER=local is not allowed in production (ephemeral disk) — use cloudinary');
    }
    if (process.env.FILE_URL_SECRET === undefined) problems.push('FILE_URL_SECRET must be set');
    if (config.CORS_ORIGINS.includes('*')) {
      console.warn('[env] CORS_ORIGINS=* in production — restrict it to your web origins.');
    }
  } else if (config.OTP_MODE === 'fixed') {
    console.warn(`[env] OTP_MODE=fixed (${APP_ENV}) — every OTP is ${config.OTP_FIXED_CODE}. Never use in production.`);
  }
  if (problems.length) {
    const msg = `[env] Unsafe production configuration:\n  - ${problems.join('\n  - ')}`;
    console.error(msg);
    throw new Error(msg);
  }
  console.log(`[env] APP_ENV=${APP_ENV} NODE_ENV=${NODE_ENV}`);
}
checkConfig();

module.exports = config;
