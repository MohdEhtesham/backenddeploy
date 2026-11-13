// Pure billing math — no database access, fully unit-tested.
//
// Accounting model:
//   * Invoices carry signed line items (charges positive, discounts negative).
//   * Payments are money received; each payment is allocated to invoices and
//     any unallocated remainder is the tenant's advance credit.
//   * Security deposit is billed on a DEPOSIT invoice; at checkout the held
//     deposit (+ advance credit) is adjusted against dues and the rest is
//     refunded.

const { round2, sum, max0 } = require('../../core/money');
const D = require('../../core/dates');

const LINE_TYPES = [
  'RENT',
  'SECURITY_DEPOSIT',
  'ELECTRICITY',
  'WATER',
  'FOOD',
  'MAINTENANCE',
  'OTHER',
  'DISCOUNT',
  'LATE_FEE',
  'DAMAGE',
  'NOTICE_SHORTFALL',
];

const RECURRING_CHARGE_TYPES = ['FOOD', 'MAINTENANCE', 'WATER', 'ELECTRICITY', 'OTHER'];

const LINE_LABELS = {
  RENT: 'Rent',
  SECURITY_DEPOSIT: 'Security deposit',
  ELECTRICITY: 'Electricity',
  WATER: 'Water',
  FOOD: 'Food / mess',
  MAINTENANCE: 'Maintenance',
  OTHER: 'Other charges',
  DISCOUNT: 'Discount',
  LATE_FEE: 'Late fee',
  DAMAGE: 'Damage charges',
  NOTICE_SHORTFALL: 'Notice period shortfall',
};

const prorate = (amount, chargedDays, fullDays) => {
  if (!fullDays || chargedDays >= fullDays) return round2(amount);
  if (chargedDays <= 0) return 0;
  return round2((Number(amount) * chargedDays) / fullDays);
};

/**
 * The first (possibly partial) billing period for a stay starting on
 * `startDate`, plus the date the next full period begins.
 */
const firstPeriod = (startDate, billingDay) => {
  const start = D.toDay(startDate);
  const anchor = D.periodStartOn(start, billingDay);
  const next = D.nextPeriodStart(anchor);
  return {
    periodStart: start,
    periodEnd: D.addDays(next, -1),
    periodKey: D.periodKeyOf(anchor),
    nextBillingDate: next,
    chargedDays: D.diffDays(start, next),
    fullDays: D.diffDays(anchor, next),
  };
};

/** A full billing period beginning on `periodStart`. */
const fullPeriod = periodStart => {
  const start = D.toDay(periodStart);
  const next = D.nextPeriodStart(start);
  const days = D.diffDays(start, next);
  return {
    periodStart: start,
    periodEnd: D.addDays(next, -1),
    periodKey: D.periodKeyOf(start),
    nextBillingDate: next,
    chargedDays: days,
    fullDays: days,
  };
};

const computeDiscount = (discount, base) => {
  if (!discount || !(Number(discount.value) > 0) || !(base > 0)) return 0;
  if (discount.type === 'PERCENT') return round2((Math.min(100, Number(discount.value)) * base) / 100);
  return round2(Math.min(Number(discount.value), base));
};

/**
 * Line items for one rent period.
 * @param rent { monthlyRent, charges: [{type,label,amount}], discount: {type,value,label} }
 * @param period { chargedDays, fullDays }
 */
const buildRentLines = (rent, period) => {
  const partial = period.chargedDays < period.fullDays;
  const rentAmount = prorate(rent.monthlyRent, period.chargedDays, period.fullDays);
  const lines = [
    {
      type: 'RENT',
      description: partial ? `Rent (${period.chargedDays} of ${period.fullDays} days)` : 'Monthly rent',
      amount: rentAmount,
    },
  ];
  for (const c of rent.charges || []) {
    const amount = prorate(c.amount, period.chargedDays, period.fullDays);
    if (!(amount > 0)) continue;
    lines.push({ type: c.type, description: c.label || LINE_LABELS[c.type] || 'Charge', amount });
  }
  const discount = computeDiscount(rent.discount, rentAmount);
  if (discount > 0) {
    lines.push({
      type: 'DISCOUNT',
      description: (rent.discount && rent.discount.label) || 'Discount',
      amount: -discount,
    });
  }
  return lines;
};

/** Invoice totals from signed lines. The total never goes below zero. */
const invoiceTotals = lines => {
  const charges = sum(lines.filter(l => l.amount > 0).map(l => l.amount));
  const credits = sum(lines.filter(l => l.amount < 0).map(l => -l.amount));
  return { subtotal: charges, discountTotal: credits, total: max0(charges - credits) };
};

/**
 * Late fee owed on an unpaid invoice as of `today`.
 * policy: { type: 'NONE'|'FLAT'|'PER_DAY', amount, graceDays, maxAmount }
 */
const computeLateFee = (policy, dueDate, today) => {
  if (!policy || policy.type === 'NONE' || !(Number(policy.amount) > 0)) return 0;
  const lateFrom = D.addDays(dueDate, Math.max(0, parseInt(policy.graceDays, 10) || 0));
  const daysLate = D.diffDays(lateFrom, today);
  if (daysLate <= 0) return 0;
  if (policy.type === 'FLAT') return round2(policy.amount);
  const fee = round2(Number(policy.amount) * daysLate);
  return Number(policy.maxAmount) > 0 ? Math.min(fee, round2(policy.maxAmount)) : fee;
};

/**
 * Invoice status given its money state.
 * inv: { status, total, amountPaid, dueDate }, graceDays: org setting
 */
const deriveInvoiceStatus = (inv, today, graceDays = 0) => {
  if (inv.status === 'CANCELLED') return 'CANCELLED';
  const balance = round2(inv.total - (inv.amountPaid || 0));
  if (balance <= 0) return 'PAID';
  if (inv.dueDate && D.diffDays(D.addDays(inv.dueDate, graceDays || 0), today) > 0) return 'OVERDUE';
  return (inv.amountPaid || 0) > 0 ? 'PARTIALLY_PAID' : 'PENDING';
};

/**
 * Rent owed for days after the last invoiced period. A stay is the
 * half-open range [check-in day, checkout day): the check-in day is
 * charged, the checkout day is not (hotel-style). `nextBillingDate` is the
 * first day not yet invoiced.
 */
const uninvoicedRent = ({ monthlyRent, charges, discount }, nextBillingDate, checkoutDate) => {
  const lines = [];
  if (!nextBillingDate) return lines;
  let start = D.toDay(nextBillingDate);
  const end = D.addDays(checkoutDate, -1); // last occupied day
  let guard = 0;
  while (start.getTime() <= end.getTime() && guard++ < 36) {
    const period = fullPeriod(start);
    const lastDay = period.periodEnd.getTime() <= end.getTime() ? period.periodEnd : end;
    const chargedDays = D.diffDays(start, lastDay) + 1;
    for (const line of buildRentLines({ monthlyRent, charges, discount }, { chargedDays, fullDays: period.fullDays })) {
      lines.push({ ...line, description: `${line.description} · ${D.dayKey(start)} → ${D.dayKey(lastDay)}` });
    }
    start = period.nextBillingDate;
  }
  return lines;
};

/**
 * Checkout settlement preview.
 *
 * input:
 *   checkoutDate, monthlyRent, charges, discount, nextBillingDate
 *   openInvoices: [{ id, invoiceNumber, balance }]
 *   electricity, damages: [{description, amount}], otherCharges: [{description, amount}]
 *   depositHeld, creditBalance
 *   notice: { noticePeriodDays, noticeGivenAt, chargeShortfall }
 */
const computeSettlement = input => {
  const checkoutDate = D.toDay(input.checkoutDate);
  const newLines = uninvoicedRent(
    { monthlyRent: input.monthlyRent, charges: input.charges, discount: input.discount },
    input.nextBillingDate,
    checkoutDate,
  );

  // Notice period shortfall: rent for the days between the last day already
  // paid for and the last day of the notice period (both inclusive
  // calendar days — 30 days' notice given on the 1st runs to the 30th).
  const notice = input.notice || {};
  let noticeShortfallDays = 0;
  if (notice.chargeShortfall && Number(notice.noticePeriodDays) > 0) {
    const noticeStart = notice.noticeGivenAt ? D.toDay(notice.noticeGivenAt) : checkoutDate;
    const requiredLastDay = D.addDays(noticeStart, Number(notice.noticePeriodDays) - 1);
    const lastOccupied = D.addDays(checkoutDate, -1);
    const lastPaid = input.nextBillingDate
      ? new Date(Math.max(lastOccupied.getTime(), D.addDays(input.nextBillingDate, -1).getTime()))
      : lastOccupied;
    noticeShortfallDays = Math.max(0, D.diffDays(lastPaid, requiredLastDay));
    if (noticeShortfallDays > 0) {
      newLines.push({
        type: 'NOTICE_SHORTFALL',
        description: `Notice period shortfall (${noticeShortfallDays} days)`,
        amount: round2((Number(input.monthlyRent) / 30) * noticeShortfallDays),
      });
    }
  }

  if (Number(input.electricity) > 0) {
    newLines.push({ type: 'ELECTRICITY', description: 'Electricity (final)', amount: round2(input.electricity) });
  }
  for (const d of input.damages || []) {
    if (Number(d.amount) > 0) newLines.push({ type: 'DAMAGE', description: d.description || 'Damage', amount: round2(d.amount) });
  }
  for (const o of input.otherCharges || []) {
    if (Number(o.amount) > 0) newLines.push({ type: 'OTHER', description: o.description || 'Other', amount: round2(o.amount) });
  }

  const newCharges = invoiceTotals(newLines).total;
  const pendingDues = sum((input.openInvoices || []).map(i => i.balance));
  const totalDues = round2(pendingDues + newCharges);
  const depositHeld = max0(input.depositHeld || 0);
  const creditBalance = max0(input.creditBalance || 0);

  // Advance credit is consumed first, then the deposit.
  const creditApplied = Math.min(creditBalance, totalDues);
  const depositApplied = Math.min(depositHeld, round2(totalDues - creditApplied));
  const refundDeposit = round2(depositHeld - depositApplied);
  const refundCredit = round2(creditBalance - creditApplied);
  const amountDue = round2(totalDues - creditApplied - depositApplied);

  return {
    checkoutDate: D.dayKey(checkoutDate),
    newLines,
    newCharges,
    pendingDues,
    totalDues,
    depositHeld,
    creditBalance,
    creditApplied: round2(creditApplied),
    depositApplied: round2(depositApplied),
    refundDeposit,
    refundCredit,
    refundTotal: round2(refundDeposit + refundCredit),
    amountDue,
    noticeShortfallDays,
  };
};

module.exports = {
  LINE_TYPES,
  LINE_LABELS,
  RECURRING_CHARGE_TYPES,
  prorate,
  firstPeriod,
  fullPeriod,
  computeDiscount,
  buildRentLines,
  invoiceTotals,
  computeLateFee,
  deriveInvoiceStatus,
  uninvoicedRent,
  computeSettlement,
};
