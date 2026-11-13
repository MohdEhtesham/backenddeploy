const os = require('os');
const env = require('../../config/env');
const JobLock = require('./JobLock');
const Organization = require('../saas/models/Organization');
const Subscription = require('../saas/models/Subscription');
const Visitor = require('../pg/models/Visitor');
const Bed = require('../pg/models/Bed');
const { generateDueInvoices, refreshOverdue, sendRentReminders } = require('../pg/services/invoices');
const { sweepPendingPayments } = require('../pg/services/payments');
const { refreshSubscription } = require('../saas/services/entitlements');
const { memberUserIds } = require('../saas/services/members');
const { unscoped } = require('../core/scope');
const { notify } = require('../notifications/dispatcher');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const LEASE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

const activeOrgIds = async () => (await Organization.find({ status: 'ACTIVE' }).select('_id').lean()).map(o => o._id);

/** Run fn for every active organization, sequentially, isolating failures. */
const forEachOrg = async fn => {
  const ids = await activeOrgIds();
  const summary = { organizations: ids.length, failed: 0 };
  for (const orgId of ids) {
    try {
      const r = await fn(orgId);
      for (const [k, v] of Object.entries(r || {})) if (typeof v === 'number') summary[k] = (summary[k] || 0) + v;
    } catch (e) {
      summary.failed += 1;
      console.error(`[jobs] org ${orgId} failed:`, e.message);
    }
  }
  return summary;
};

// ---- Subscription lifecycle + reminders ------------------------------------------

const subscriptionJob = async () => {
  const subs = await unscoped(() => Subscription.find({}).select('organizationId status trialEndsAt currentPeriodEnd cancelAtPeriodEnd remindersSent planCode').lean());
  let transitioned = 0;
  let reminded = 0;
  const now = Date.now();
  for (const s of subs) {
    const fresh = await refreshSubscription(s.organizationId);
    if (fresh && fresh.status !== s.status) transitioned += 1;
    if (!fresh) continue;

    let key = null;
    let title = '';
    let body = '';
    if (fresh.status === 'TRIAL' && fresh.trialEndsAt) {
      const days = Math.ceil((new Date(fresh.trialEndsAt).getTime() - now) / DAY_MS);
      if (days <= 3 && days >= 1) {
        key = `trial:${days <= 1 ? 1 : 3}:${new Date(fresh.trialEndsAt).toISOString().slice(0, 10)}`;
        title = days <= 1 ? 'Your trial ends tomorrow' : `Your trial ends in ${days} days`;
        body = 'Choose a plan to keep managing your PG without interruption.';
      }
    } else if (fresh.status === 'ACTIVE' && fresh.currentPeriodEnd && !fresh.cancelAtPeriodEnd) {
      const days = Math.ceil((new Date(fresh.currentPeriodEnd).getTime() - now) / DAY_MS);
      if (days <= 3 && days >= 1) {
        key = `renewal:${new Date(fresh.currentPeriodEnd).toISOString().slice(0, 10)}`;
        title = 'Subscription renews soon';
        body = `Your ${fresh.planCode} plan period ends in ${days} day(s). Renew to avoid interruption.`;
      }
    }
    if (!key || (fresh.remindersSent || []).includes(key)) continue;
    const claimed = await Subscription.updateOne(
      { organizationId: fresh.organizationId, _id: fresh._id, remindersSent: { $ne: key } },
      { $push: { remindersSent: key } },
    );
    if (!claimed.modifiedCount) continue;
    reminded += 1;
    const owners = await memberUserIds(fresh.organizationId, ['OWNER']);
    notify({ userIds: owners, organizationId: fresh.organizationId, type: 'subscription', title, body, data: { route: 'subscription' }, channels: ['inapp', 'push', 'email'] });
  }
  return { subscriptions: subs.length, transitioned, reminded };
};

// ---- Housekeeping ---------------------------------------------------------------------

const expireVisitorPasses = orgId =>
  Visitor.updateMany(
    { organizationId: orgId, status: { $in: ['REQUESTED', 'APPROVED'] }, validUntil: { $lt: new Date() } },
    { $set: { status: 'EXPIRED' } },
  ).then(r => ({ expired: r.modifiedCount }));

const releaseReservations = orgId =>
  Bed.updateMany(
    { organizationId: orgId, status: 'RESERVED', reservedUntil: { $lt: new Date() } },
    { $set: { status: 'AVAILABLE', reservedForTenantId: null, reservedUntil: null, statusChangedAt: new Date(), statusNote: 'Reservation expired' } },
  ).then(r => ({ released: r.modifiedCount }));

const JOBS = {
  'generate-invoices': () => forEachOrg(generateDueInvoices),
  'refresh-overdue': () => forEachOrg(refreshOverdue),
  'rent-reminders': () => forEachOrg(sendRentReminders),
  'sweep-payments': () => forEachOrg(sweepPendingPayments),
  subscriptions: subscriptionJob,
  'expire-visitors': () => forEachOrg(expireVisitorPasses),
  'release-reservations': () => forEachOrg(releaseReservations),
};

const acquire = async name => {
  const now = new Date();
  try {
    return await JobLock.findOneAndUpdate(
      { _id: name, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
      { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS), lockedBy: WORKER_ID } },
      { upsert: true, new: true },
    );
  } catch (e) {
    if (e && e.code === 11000) return null; // held by another worker
    throw e;
  }
};

/** Run one job under its lease. Returns { skipped } when another worker holds it. */
const runJob = async name => {
  if (!JOBS[name]) throw new Error(`Unknown job: ${name}`);
  const lock = await acquire(name);
  if (!lock) return { job: name, skipped: true };
  const started = Date.now();
  try {
    const result = await JOBS[name]();
    await JobLock.updateOne({ _id: name }, { $set: { lockedUntil: null, lastRunAt: new Date(), lastDurationMs: Date.now() - started, lastResult: result, lastError: '' } });
    return { job: name, ...result };
  } catch (e) {
    await JobLock.updateOne({ _id: name }, { $set: { lockedUntil: null, lastRunAt: new Date(), lastError: String(e.message).slice(0, 500) } });
    throw e;
  }
};

const runAll = async () => {
  const out = [];
  for (const name of Object.keys(JOBS)) {
    try {
      out.push(await runJob(name));
    } catch (e) {
      console.error(`[jobs] ${name} failed:`, e.message);
      out.push({ job: name, error: e.message });
    }
  }
  return out;
};

let timer = null;

const startScheduler = () => {
  if (!env.JOBS_ENABLED || timer) return;
  const every = Math.max(5, env.JOBS_INTERVAL_MINUTES) * 60 * 1000;
  const tick = () =>
    runAll()
      .then(results => console.log('[jobs] run complete', JSON.stringify(results.map(r => ({ job: r.job, skipped: r.skipped, error: r.error })))))
      .catch(e => console.error('[jobs] run failed', e));
  setTimeout(tick, 30 * 1000).unref();
  timer = setInterval(tick, every);
  timer.unref();
  console.log(`[jobs] scheduler started (every ${Math.round(every / 60000)} min)`);
};

const stopScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

module.exports = { JOBS, runJob, runAll, startScheduler, stopScheduler };
