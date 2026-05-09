require('dotenv').config();

const required = ['MONGODB_URI', 'JWT_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    console.warn(`[env] Missing required env var: ${key}`);
  }
}

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 4000,
  MONGODB_URI: process.env.MONGODB_URI || '',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-me',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '30d',
  CORS_ORIGINS: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  CLOUDINARY: {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
    api_key: process.env.CLOUDINARY_API_KEY || '',
    api_secret: process.env.CLOUDINARY_API_SECRET || '',
  },
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX, 10) || 300,
};
