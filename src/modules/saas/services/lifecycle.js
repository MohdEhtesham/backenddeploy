// Pure subscription state machine (unit-tested). No I/O.
//
//   TRIAL ──trial ends──▶ EXPIRED            (or ACTIVE on the free plan when
//                                              trialExpiryAction=DOWNGRADE_TO_FREE)
//   ACTIVE ──period ends──▶ PAST_DUE ──grace ends──▶ EXPIRED
//   ACTIVE ──period ends & cancelAtPeriodEnd──▶ CANCELLED
//   any ──super admin──▶ SUSPENDED
//
// Writable (full access): TRIAL, ACTIVE, PAST_DUE (grace).
// Read-only: CANCELLED, EXPIRED, SUSPENDED.

const DAY_MS = 24 * 60 * 60 * 1000;
const WRITABLE_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE'];

const time = d => (d ? new Date(d).getTime() : null);

const nextLifecycle = (sub, now, settings) => {
  const t = now.getTime();
  const next = {
    status: sub.status,
    planCode: sub.planCode,
    currentPeriodStart: sub.currentPeriodStart || null,
    currentPeriodEnd: sub.currentPeriodEnd || null,
    cancelledAt: sub.cancelledAt || null,
    pastDueSince: sub.pastDueSince || null,
  };
  const events = [];

  if (next.status === 'TRIAL' && sub.trialEndsAt && t >= time(sub.trialEndsAt)) {
    if (settings.trialExpiryAction === 'DOWNGRADE_TO_FREE') {
      next.status = 'ACTIVE';
      next.planCode = settings.freePlanCode;
      next.currentPeriodStart = now;
      next.currentPeriodEnd = null;
      events.push('trial_downgraded');
    } else {
      next.status = 'EXPIRED';
      events.push('trial_expired');
    }
  }

  if (next.status === 'ACTIVE' && next.currentPeriodEnd && t >= time(next.currentPeriodEnd)) {
    if (sub.cancelAtPeriodEnd) {
      next.status = 'CANCELLED';
      next.cancelledAt = next.cancelledAt || now;
      events.push('cancelled');
    } else {
      next.status = 'PAST_DUE';
      next.pastDueSince = new Date(next.currentPeriodEnd);
      events.push('past_due');
    }
  }

  if (
    next.status === 'PAST_DUE' &&
    next.pastDueSince &&
    t >= time(next.pastDueSince) + (Number(settings.graceDays) || 0) * DAY_MS
  ) {
    next.status = 'EXPIRED';
    events.push('expired');
  }

  const changes = {};
  for (const [k, v] of Object.entries(next)) {
    const before = sub[k] instanceof Date ? sub[k].getTime() : sub[k] ?? null;
    const after = v instanceof Date ? v.getTime() : v ?? null;
    if (before !== after) changes[k] = v;
  }
  return { changes, events };
};

const isWritable = status => WRITABLE_STATUSES.includes(status);

/** Days (ceil) until a timestamp, or null. */
const daysUntil = (date, now = new Date()) => {
  if (!date) return null;
  return Math.max(0, Math.ceil((new Date(date).getTime() - now.getTime()) / DAY_MS));
};

module.exports = { nextLifecycle, isWritable, daysUntil, WRITABLE_STATUSES, DAY_MS };
