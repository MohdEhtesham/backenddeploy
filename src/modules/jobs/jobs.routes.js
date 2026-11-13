const crypto = require('crypto');
const router = require('express').Router();
const env = require('../../config/env');
const { JOBS, runJob, runAll } = require('./scheduler');

// External cron trigger (Render cron job / GitHub Actions / any scheduler):
//   POST /api/internal/jobs/all              with header  X-Cron-Secret
//   POST /api/internal/jobs/generate-invoices
// Disabled entirely unless CRON_SECRET is configured.
const authorized = req => {
  if (!env.CRON_SECRET) return false;
  const given = Buffer.from(String(req.get('x-cron-secret') || ''));
  const expected = Buffer.from(env.CRON_SECRET);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

router.post('/jobs/:name', async (req, res, next) => {
  if (!authorized(req)) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found' });
  try {
    const { name } = req.params;
    if (name === 'all') return res.json({ success: true, data: await runAll() });
    if (!JOBS[name]) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: `Unknown job ${name}` });
    return res.json({ success: true, data: await runJob(name) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
