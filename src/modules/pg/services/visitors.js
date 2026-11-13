const crypto = require('crypto');
const errors = require('../../core/errors');

const FLOW = {
  REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  APPROVED: ['CHECKED_IN', 'CANCELLED', 'EXPIRED'],
  CHECKED_IN: ['CHECKED_OUT'],
  REJECTED: [],
  CHECKED_OUT: [],
  CANCELLED: [],
  EXPIRED: [],
};

const passCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/** Keep only the last 4 characters of an ID document number. */
const maskIdNumber = value => {
  const v = String(value || '').replace(/\s+/g, '');
  if (!v) return '';
  return v.length <= 4 ? '••••' : `${'•'.repeat(Math.min(8, v.length - 4))}${v.slice(-4)}`;
};

const assertVisitorTransition = (visitor, to) => {
  if (!(FLOW[visitor.status] || []).includes(to)) {
    throw errors.conflict(`Visitor pass is ${visitor.status.toLowerCase().replace('_', ' ')}.`, 'INVALID_TRANSITION', {
      from: visitor.status,
      to,
    });
  }
  if (to === 'CHECKED_IN' && visitor.validUntil && new Date(visitor.validUntil) < new Date()) {
    throw errors.conflict('This visitor pass has expired.', 'VISITOR_PASS_EXPIRED');
  }
};

module.exports = { FLOW, passCode, maskIdNumber, assertVisitorTransition };
