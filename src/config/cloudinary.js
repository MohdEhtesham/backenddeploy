const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { CLOUDINARY, CLOUDINARY_ENABLED } = require('./env');

let upload;

if (CLOUDINARY_ENABLED) {
  // Lazy-require so the package isn't loaded when creds are missing
  // (avoids any incidental config errors on bare-minimum deploys).
  const { CloudinaryStorage } = require('multer-storage-cloudinary');
  cloudinary.config(CLOUDINARY);

  const storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'aabroo',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
      transformation: [{ width: 1600, crop: 'limit', quality: 'auto' }],
    },
  });

  upload = multer({
    storage,
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  });
} else {
  // Fallback middleware that returns 503 — keeps app booting without Cloudinary creds.
  const stub503 = (_req, res) =>
    res.status(503).json({
      success: false,
      message: 'Image upload is disabled (Cloudinary not configured on this server).',
    });

  upload = {
    single: () => stub503,
    array: () => stub503,
    fields: () => stub503,
    any: () => stub503,
    none: () => stub503,
  };
}

module.exports = { cloudinary, upload };
