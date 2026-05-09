const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const { CLOUDINARY } = require('./env');

cloudinary.config(CLOUDINARY);

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'aabroo',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1600, crop: 'limit', quality: 'auto' }],
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
});

module.exports = { cloudinary, upload };
