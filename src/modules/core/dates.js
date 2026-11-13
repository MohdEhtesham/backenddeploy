// Calendar-date helpers.
//
// Date-only business values (joining date, checkout date, billing periods,
// attendance days) are stored as UTC-midnight Dates and exchanged with
// clients as 'YYYY-MM-DD'. "Today" is resolved in the organization's time
// zone (Asia/Kolkata by default) so a payment at 00:30 IST lands on the
// right day.

const { DEFAULT_TIMEZONE } = require('../../config/env');

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const parseDay = key => {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

/** UTC-midnight Date for the calendar day of `input` ('YYYY-MM-DD' | Date | ISO). */
const toDay = input => {
  if (input instanceof Date) {
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  }
  if (typeof input === 'string' && DAY_KEY_RE.test(input)) return parseDay(input);
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
  return toDay(d);
};

const dayKey = date => toDay(date).toISOString().slice(0, 10);

/** Calendar day "now" in a time zone, as a UTC-midnight Date. */
const todayIn = (tz = DEFAULT_TIMEZONE, now = new Date()) => {
  const key = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parseDay(key);
};

const addDays = (date, n) => new Date(toDay(date).getTime() + n * DAY_MS);

const daysInMonth = (year, month0) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

const addMonths = (date, n) => {
  const d = toDay(date);
  const total = d.getUTCMonth() + n;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  return new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), daysInMonth(year, month))));
};

/** Whole days from `a` to `b` (b - a). */
const diffDays = (a, b) => Math.round((toDay(b).getTime() - toDay(a).getTime()) / DAY_MS);

const startOfMonth = date => {
  const d = toDay(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

// ---- Billing periods --------------------------------------------------------
// A billing period starts on `billingDay` (1..28, so every month has it) and
// runs until the day before the same day next month.

const clampBillingDay = d => Math.min(28, Math.max(1, parseInt(d, 10) || 1));

/** Start of the billing period that contains `date`. */
const periodStartOn = (date, billingDay) => {
  const d = toDay(date);
  const bd = clampBillingDay(billingDay);
  const candidate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), bd));
  return candidate.getTime() <= d.getTime()
    ? candidate
    : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, bd));
};

const nextPeriodStart = periodStart => addMonths(periodStart, 1);

/** Inclusive last day of the period. */
const periodEndOf = periodStart => addDays(nextPeriodStart(periodStart), -1);

const periodLength = periodStart => diffDays(periodStart, nextPeriodStart(periodStart));

/** 'YYYY-MM' label of the period (month in which it starts). */
const periodKeyOf = periodStart => dayKey(periodStart).slice(0, 7);

module.exports = {
  DAY_MS,
  DAY_KEY_RE,
  parseDay,
  toDay,
  dayKey,
  todayIn,
  addDays,
  addMonths,
  diffDays,
  daysInMonth,
  startOfMonth,
  clampBillingDay,
  periodStartOn,
  nextPeriodStart,
  periodEndOf,
  periodLength,
  periodKeyOf,
};
