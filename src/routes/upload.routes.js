const router = require('express').Router();
const { upload } = require('../config/cloudinary');
const { authRequired } = require('../middleware/auth');
const { ok } = require('../utils/respond');

router.use(authRequired);

router.post('/single', upload.single('file'), (req, res) => {
  if (!req.file) return ok(res, null, 'No file');
  ok(res, { url: req.file.path, publicId: req.file.filename });
});

router.post('/multiple', upload.array('files', 10), (req, res) => {
  const files = (req.files || []).map(f => ({ url: f.path, publicId: f.filename }));
  ok(res, files);
});

module.exports = router;
