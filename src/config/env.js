require('dotenv').config();

// Accept either MONGODB_URI or MONGO_URI (different conventions across hosts)
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || '';
const JWT_SECRET = process.env.JWT_SECRET || '';

// Cloudinary creds — uploads endpoint will gracefully disable if missing
const CLOUDINARY = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
  api_key: process.env.CLOUDINARY_API_KEY || '',
  api_secret: process.env.CLOUDINARY_API_SECRET || '',
};
const CLOUDINARY_ENABLED = Boolean(
  CLOUDINARY.cloud_name && CLOUDINARY.api_key && CLOUDINARY.api_secret,
);

// Friendly, loud startup diagnostics
function checkConfig() {
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
}
checkConfig();

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 4000,
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
};
