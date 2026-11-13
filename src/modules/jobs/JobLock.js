const mongoose = require('mongoose');

// One row per job name — a lease so that several API instances (or an
// external cron hitting /api/internal/jobs) never run the same job twice at
// once.
const JobLockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    lockedUntil: { type: Date, default: null },
    lockedBy: { type: String, default: '' },
    lastRunAt: { type: Date, default: null },
    lastDurationMs: { type: Number, default: 0 },
    lastResult: { type: mongoose.Schema.Types.Mixed, default: null },
    lastError: { type: String, default: '' },
  },
  { collection: 'jobs_locks', versionKey: false },
);

module.exports = mongoose.models.JobLock || mongoose.model('JobLock', JobLockSchema);
