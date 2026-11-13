const errors = require('../../core/errors');

// Status machines for complaints and maintenance tasks. Every accepted
// transition stamps its timestamp and appends to the history log.

const COMPLAINT_FLOW = {
  OPEN: ['ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  ASSIGNED: ['IN_PROGRESS', 'RESOLVED', 'CLOSED', 'OPEN'],
  IN_PROGRESS: ['RESOLVED', 'ASSIGNED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS', 'OPEN'],
  CLOSED: ['OPEN'],
};

const MAINTENANCE_FLOW = {
  CREATED: ['ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  ASSIGNED: ['IN_PROGRESS', 'RESOLVED', 'CLOSED', 'CREATED'],
  IN_PROGRESS: ['RESOLVED', 'ASSIGNED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: [],
};

const STAMP = {
  ASSIGNED: 'assignedAt',
  IN_PROGRESS: 'inProgressAt',
  RESOLVED: 'resolvedAt',
  CLOSED: 'closedAt',
};

const canTransition = (flow, from, to) => Boolean(flow[from] && flow[from].includes(to));

/** Apply a validated transition to a document in memory (caller saves). */
const transition = (doc, to, flow, { userId = null, userName = '', note = '' } = {}) => {
  if (doc.status === to) throw errors.conflict(`Already ${to.toLowerCase().replace('_', ' ')}.`, 'INVALID_TRANSITION');
  if (!canTransition(flow, doc.status, to)) {
    throw errors.conflict(`Cannot change status from ${doc.status} to ${to}.`, 'INVALID_TRANSITION', {
      from: doc.status,
      to,
      allowed: flow[doc.status] || [],
    });
  }
  const now = new Date();
  if (to === 'OPEN' || to === 'CREATED') {
    // Re-opened: clear completion stamps, keep history.
    doc.resolvedAt = null;
    doc.closedAt = null;
  }
  if (STAMP[to]) doc[STAMP[to]] = now;
  doc.status = to;
  doc.history.push({ status: to, at: now, byUserId: userId, byName: userName, note: note || '' });
  return doc;
};

module.exports = { COMPLAINT_FLOW, MAINTENANCE_FLOW, canTransition, transition };
