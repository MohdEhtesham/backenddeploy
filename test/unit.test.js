// Pure logic: money, dates, billing math, settlement, subscription state
// machine, workflows, CSV, masking. No database.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { round2, sum, toPaise, fromPaise } = require('../src/modules/core/money');
const D = require('../src/modules/core/dates');
const billing = require('../src/modules/pg/services/billing');
const { nextLifecycle, isWritable } = require('../src/modules/saas/services/lifecycle');
const { transition, COMPLAINT_FLOW, MAINTENANCE_FLOW } = require('../src/modules/pg/services/workflow');
const { maskIdNumber, assertVisitorTransition } = require('../src/modules/pg/services/visitors');
const { toCsv } = require('../src/modules/core/csv');
const { clean } = require('../src/modules/core/http');
const { formatINR } = require('../src/modules/pg/services/format');
const { sanitizeProps } = require('../src/modules/analytics/track');
const { ROLE_DEFS, PERMISSIONS } = require('../src/modules/core/permissions');

test('money: rounding is exact to the paisa, half away from zero', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(-1.005), -1.01);
  assert.equal(round2(2.675), 2.68);
  assert.equal(sum([0.1, 0.2, 0.3]), 0.6);
  assert.equal(toPaise(1234.56), 123456);
  assert.equal(fromPaise(123456), 1234.56);
  assert.equal(round2('abc'), 0);
  assert.equal(Object.is(round2(-0.001), -0), false);
});

test('dates: billing periods anchor on the billing day', () => {
  assert.equal(D.dayKey(D.periodStartOn('2026-03-15', 1)), '2026-03-01');
  assert.equal(D.dayKey(D.periodStartOn('2026-03-04', 5)), '2026-02-05');
  assert.equal(D.dayKey(D.periodStartOn('2026-03-05', 5)), '2026-03-05');
  assert.equal(D.dayKey(D.addMonths('2026-01-31', 1)), '2026-02-28');
  assert.equal(D.dayKey(D.addMonths('2024-01-31', 1)), '2024-02-29');
  assert.equal(D.diffDays('2026-02-01', '2026-03-01'), 28);
  assert.equal(D.periodKeyOf(D.toDay('2026-09-05')), '2026-09');
  assert.equal(D.clampBillingDay(31), 28);
  assert.equal(D.clampBillingDay(0), 1);
});

test('dates: today resolves in the organization time zone', () => {
  // 20:00 UTC on 27 Sep is already 28 Sep in India (UTC+5:30).
  const now = new Date('2026-09-27T20:00:00Z');
  assert.equal(D.dayKey(D.todayIn('Asia/Kolkata', now)), '2026-09-28');
  assert.equal(D.dayKey(D.todayIn('UTC', now)), '2026-09-27');
});

test('billing: first period is prorated from the joining date', () => {
  const p = billing.firstPeriod('2026-09-16', 1);
  assert.equal(D.dayKey(p.periodStart), '2026-09-16');
  assert.equal(D.dayKey(p.periodEnd), '2026-09-30');
  assert.equal(D.dayKey(p.nextBillingDate), '2026-10-01');
  assert.equal(p.chargedDays, 15);
  assert.equal(p.fullDays, 30);
  const lines = billing.buildRentLines({ monthlyRent: 9000, charges: [{ type: 'FOOD', amount: 3000 }] }, p);
  assert.deepEqual(lines.map(l => [l.type, l.amount]), [['RENT', 4500], ['FOOD', 1500]]);
});

test('billing: joining on the billing day charges a full month', () => {
  const p = billing.firstPeriod('2026-09-01', 1);
  assert.equal(p.chargedDays, p.fullDays);
  const [rent] = billing.buildRentLines({ monthlyRent: 8500 }, p);
  assert.equal(rent.amount, 8500);
  assert.equal(rent.description, 'Monthly rent');
});

test('billing: discounts (flat & percent) never exceed rent', () => {
  const period = { chargedDays: 30, fullDays: 30 };
  const flat = billing.buildRentLines({ monthlyRent: 5000, discount: { type: 'FLAT', value: 500 } }, period);
  assert.deepEqual(billing.invoiceTotals(flat), { subtotal: 5000, discountTotal: 500, total: 4500 });
  const pct = billing.buildRentLines({ monthlyRent: 5000, discount: { type: 'PERCENT', value: 10 } }, period);
  assert.equal(billing.invoiceTotals(pct).total, 4500);
  const huge = billing.buildRentLines({ monthlyRent: 5000, discount: { type: 'FLAT', value: 999999 } }, period);
  assert.equal(billing.invoiceTotals(huge).total, 0);
});

test('billing: late fee policies', () => {
  const due = D.toDay('2026-09-05');
  assert.equal(billing.computeLateFee({ type: 'NONE', amount: 100 }, due, D.toDay('2026-09-20')), 0);
  assert.equal(billing.computeLateFee({ type: 'FLAT', amount: 250, graceDays: 2 }, due, D.toDay('2026-09-07')), 0);
  assert.equal(billing.computeLateFee({ type: 'FLAT', amount: 250, graceDays: 2 }, due, D.toDay('2026-09-08')), 250);
  assert.equal(billing.computeLateFee({ type: 'PER_DAY', amount: 50, graceDays: 0 }, due, D.toDay('2026-09-15')), 500);
  assert.equal(billing.computeLateFee({ type: 'PER_DAY', amount: 50, graceDays: 0, maxAmount: 300 }, due, D.toDay('2026-09-15')), 300);
});

test('billing: invoice status derivation', () => {
  const today = D.toDay('2026-09-10');
  const base = { total: 1000, dueDate: D.toDay('2026-09-05'), status: 'PENDING' };
  assert.equal(billing.deriveInvoiceStatus({ ...base, amountPaid: 1000 }, today), 'PAID');
  assert.equal(billing.deriveInvoiceStatus({ ...base, amountPaid: 200 }, today), 'OVERDUE');
  assert.equal(billing.deriveInvoiceStatus({ ...base, dueDate: D.toDay('2026-09-15'), amountPaid: 200 }, today), 'PARTIALLY_PAID');
  assert.equal(billing.deriveInvoiceStatus({ ...base, dueDate: D.toDay('2026-09-15'), amountPaid: 0 }, today), 'PENDING');
  assert.equal(billing.deriveInvoiceStatus({ ...base, status: 'CANCELLED', amountPaid: 0 }, today), 'CANCELLED');
});

test('settlement: uninvoiced days, damages and deposit refund', () => {
  const s = billing.computeSettlement({
    checkoutDate: '2026-10-10',
    monthlyRent: 9000,
    charges: [],
    nextBillingDate: '2026-10-01',
    openInvoices: [{ id: 'i1', balance: 1000 }],
    electricity: 450,
    damages: [{ description: 'Broken chair', amount: 800 }],
    otherCharges: [],
    depositHeld: 18000,
    creditBalance: 500,
    notice: { noticePeriodDays: 0, chargeShortfall: false },
  });
  // Leaves on 10 Oct → occupied 1–9 Oct = 9 of 31 days (checkout day not charged).
  assert.equal(s.newLines[0].type, 'RENT');
  assert.equal(s.newLines[0].amount, round2((9000 * 9) / 31));
  assert.equal(s.newCharges, round2(round2((9000 * 9) / 31) + 450 + 800));
  assert.equal(s.pendingDues, 1000);
  assert.equal(s.creditApplied, 500);
  assert.equal(s.depositApplied, round2(s.totalDues - 500));
  assert.equal(s.refundDeposit, round2(18000 - s.depositApplied));
  assert.equal(s.amountDue, 0);
});

test('settlement: notice fully served → no shortfall; dues larger than deposit stay due', () => {
  const s = billing.computeSettlement({
    checkoutDate: '2026-09-30',
    monthlyRent: 9000,
    nextBillingDate: '2026-10-01',
    openInvoices: [{ id: 'a', balance: 9000 }, { id: 'b', balance: 9000 }],
    depositHeld: 5000,
    creditBalance: 0,
    notice: { noticePeriodDays: 30, noticeGivenAt: '2026-09-01', chargeShortfall: true },
  });
  assert.equal(s.newLines.length, 0);
  assert.equal(s.depositApplied, 5000);
  assert.equal(s.refundTotal, 0);
  assert.equal(s.amountDue, 13000);
});

test('settlement: notice shortfall counts only days not already billed', () => {
  // Notice given 20 Sep (30 days → last day 19 Oct); leaves 30 Sep; Sep already billed.
  const s = billing.computeSettlement({
    checkoutDate: '2026-09-30',
    monthlyRent: 9000,
    nextBillingDate: '2026-10-01',
    openInvoices: [],
    depositHeld: 20000,
    notice: { noticePeriodDays: 30, noticeGivenAt: '2026-09-20', chargeShortfall: true },
  });
  assert.equal(s.noticeShortfallDays, 19);
  assert.equal(s.newLines[0].type, 'NOTICE_SHORTFALL');
  assert.equal(s.newLines[0].amount, 5700);
  assert.equal(s.refundDeposit, 14300);
});

test('subscription lifecycle transitions', () => {
  const settings = { trialExpiryAction: 'EXPIRE', graceDays: 7, freePlanCode: 'FREE' };
  const now = new Date('2026-09-27T00:00:00Z');
  const trialEnded = nextLifecycle({ status: 'TRIAL', planCode: 'BUSINESS', trialEndsAt: new Date('2026-09-26') }, now, settings);
  assert.deepEqual(trialEnded.events, ['trial_expired']);
  assert.equal(trialEnded.changes.status, 'EXPIRED');

  const downgrade = nextLifecycle({ status: 'TRIAL', planCode: 'BUSINESS', trialEndsAt: new Date('2026-09-26') }, now, { ...settings, trialExpiryAction: 'DOWNGRADE_TO_FREE' });
  assert.equal(downgrade.changes.status, 'ACTIVE');
  assert.equal(downgrade.changes.planCode, 'FREE');

  const pastDue = nextLifecycle({ status: 'ACTIVE', planCode: 'STARTER', currentPeriodEnd: new Date('2026-09-25') }, now, settings);
  assert.deepEqual(pastDue.events, ['past_due']);
  const expired = nextLifecycle({ status: 'ACTIVE', planCode: 'STARTER', currentPeriodEnd: new Date('2026-09-10') }, now, settings);
  assert.deepEqual(expired.events, ['past_due', 'expired']);
  const cancelled = nextLifecycle({ status: 'ACTIVE', planCode: 'STARTER', currentPeriodEnd: new Date('2026-09-25'), cancelAtPeriodEnd: true }, now, settings);
  assert.deepEqual(cancelled.events, ['cancelled']);
  const free = nextLifecycle({ status: 'ACTIVE', planCode: 'FREE', currentPeriodEnd: null }, now, settings);
  assert.deepEqual(free.events, []);
  assert.equal(isWritable('PAST_DUE'), true);
  assert.equal(isWritable('EXPIRED'), false);
  assert.equal(isWritable('SUSPENDED'), false);
});

test('complaint / maintenance workflows reject invalid transitions', () => {
  const doc = { status: 'OPEN', history: [] };
  transition(doc, 'ASSIGNED', COMPLAINT_FLOW, { note: 'x' });
  transition(doc, 'IN_PROGRESS', COMPLAINT_FLOW);
  transition(doc, 'RESOLVED', COMPLAINT_FLOW);
  assert.ok(doc.resolvedAt instanceof Date);
  assert.equal(doc.history.length, 3);
  assert.throws(() => transition({ status: 'CLOSED', history: [] }, 'RESOLVED', COMPLAINT_FLOW), e => e.code === 'INVALID_TRANSITION');
  assert.throws(() => transition({ status: 'CLOSED', history: [] }, 'IN_PROGRESS', MAINTENANCE_FLOW), e => e.code === 'INVALID_TRANSITION');
  const reopened = { status: 'RESOLVED', resolvedAt: new Date(), history: [] };
  transition(reopened, 'OPEN', COMPLAINT_FLOW);
  assert.equal(reopened.resolvedAt, null);
});

test('visitors: ID numbers are masked, expired passes cannot enter', () => {
  assert.equal(maskIdNumber('1234 5678 9012'), '••••••••9012');
  assert.equal(maskIdNumber(''), '');
  assert.throws(() => assertVisitorTransition({ status: 'APPROVED', validUntil: new Date(Date.now() - 1000) }, 'CHECKED_IN'), e => e.code === 'VISITOR_PASS_EXPIRED');
  assert.throws(() => assertVisitorTransition({ status: 'REJECTED' }, 'CHECKED_IN'), e => e.code === 'INVALID_TRANSITION');
});

test('csv export escapes and neutralises formula injection', () => {
  const csv = toCsv([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], [{ a: 'x,y', b: '=HYPERLINK("evil")' }, { a: -5, b: 'ok' }]);
  assert.equal(csv.split('\r\n')[1], `"x,y","'=HYPERLINK(""evil"")"`);
  assert.equal(csv.split('\r\n')[2], '-5,ok');
});

test('request sanitizer strips Mongo operators', () => {
  assert.deepEqual(clean({ phone: { $gt: '' }, 'a.b': 1, ok: [{ $where: 'x', v: 1 }] }), { phone: {}, ok: [{ v: 1 }] });
});

test('analytics props drop PII-looking keys', () => {
  assert.deepEqual(sanitizeProps({ plan: 'PRO', phone: '98', email: 'x', amount: 5, nested: { a: 1 } }), { plan: 'PRO', amount: 5 });
});

test('formatINR uses Indian digit grouping', () => {
  assert.equal(formatINR(1234567), '₹12,34,567');
  assert.equal(formatINR(99.5), '₹99.50');
});

test('RBAC matrix sanity', () => {
  const has = (role, p) => ROLE_DEFS[role].permissions.includes(p);
  assert.ok(Object.keys(PERMISSIONS).length > 60);
  assert.ok(has('OWNER', 'org.billing.manage'));
  assert.ok(!has('PROPERTY_MANAGER', 'org.billing.manage'));
  assert.ok(has('ACCOUNTANT', 'payment.record'));
  assert.ok(!has('ACCOUNTANT', 'checkin.create'));
  assert.ok(has('SECURITY', 'visitor.approve'));
  assert.ok(!has('SECURITY', 'payment.read'));
  assert.ok(!has('STAFF', 'tenant.read'));
  assert.ok(has('TENANT', 'self.pay'));
  assert.ok(!has('TENANT', 'tenant.read'));
  assert.ok(!ROLE_DEFS.OWNER.permissions.some(p => p.startsWith('self.')));
});
