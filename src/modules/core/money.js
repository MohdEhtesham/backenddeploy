// Amounts are stored in rupees and always rounded to 2 decimals at every
// arithmetic step, so floating point drift can never accumulate.
// Rounding is half-away-from-zero (₹1.005 → ₹1.01, -₹1.005 → -₹1.01).
const round2 = n => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const sign = v < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(v) + Number.EPSILON) * 100)) / 100 || 0;
};

const sum = values => round2((values || []).reduce((s, x) => s + (Number(x) || 0), 0));

const toPaise = rupees => Math.round(round2(rupees) * 100);
const fromPaise = paise => round2(Number(paise) / 100);

const max0 = n => (n > 0 ? round2(n) : 0);

module.exports = { round2, sum, toPaise, fromPaise, max0 };
