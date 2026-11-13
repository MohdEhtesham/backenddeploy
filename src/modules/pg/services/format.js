const { round2 } = require('../../core/money');

/** ₹12,345.50 — Indian digit grouping, paise only when present. */
const formatINR = amount => {
  const v = round2(amount);
  const hasPaise = Math.round(Math.abs(v) * 100) % 100 !== 0;
  return `₹${v.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
};

module.exports = { formatINR };
