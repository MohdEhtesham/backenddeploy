const RentInvoice = require('../models/RentInvoice');
const Rent = require('../models/Rent');
const Tenant = require('../models/Tenant');
const Payment = require('../models/Payment');
const Organization = require('../../saas/models/Organization');
const billing = require('./billing');
const D = require('../../core/dates');
const { round2 } = require('../../core/money');
const { nextNumber } = require('../../core/counters');
const { withTransaction } = require('../../core/tx');
const { notify } = require('../../notifications/dispatcher');
const { formatINR } = require('./format');

const OPEN_STATUSES = ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'];

const orgToday = (org, now = new Date()) => D.todayIn((org && org.settings && org.settings.timezone) || undefined, now);

/** Apply `amount` to an invoice document in memory (caller saves). */
const applyToInvoice = (invoice, amount, today) => {
  invoice.amountPaid = round2((invoice.amountPaid || 0) + amount);
  invoice.balance = round2(invoice.total - invoice.amountPaid);
  invoice.status = billing.deriveInvoiceStatus(invoice, today, 0);
  if (invoice.status === 'PAID' && !invoice.paidAt) invoice.paidAt = new Date();
};

/** Recalculate totals after lines changed (caller saves). */
const recalcInvoice = (invoice, today) => {
  const totals = billing.invoiceTotals(invoice.lines);
  invoice.subtotal = totals.subtotal;
  invoice.discountTotal = totals.discountTotal;
  invoice.total = totals.total;
  invoice.balance = round2(invoice.total - (invoice.amountPaid || 0));
  if (invoice.status !== 'CANCELLED') {
    invoice.status = billing.deriveInvoiceStatus(invoice, today, 0);
    if (invoice.status === 'PAID' && !invoice.paidAt) invoice.paidAt = new Date();
    if (invoice.status !== 'PAID') invoice.paidAt = null;
  }
};

/**
 * Apply a tenant's advance credit (unallocated money on earlier payments)
 * to the given open invoices, oldest due first. Runs inside the caller's
 * session; saves invoices, payments and the tenant.
 */
const applyCredit = async ({ organizationId, tenant, invoices, today }, session) => {
  let credit = round2(tenant.creditBalance || 0);
  if (credit <= 0) return 0;
  const payments = await Payment.find({
    organizationId,
    tenantId: tenant._id,
    status: { $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] },
    unappliedAmount: { $gt: 0 },
  })
    .sort({ paidAt: 1, createdAt: 1 })
    .session(session);

  let applied = 0;
  const targets = [...invoices].sort((a, b) => a.dueDate - b.dueDate);
  for (const invoice of targets) {
    for (const payment of payments) {
      if (credit <= 0 || invoice.balance <= 0) break;
      if (payment.unappliedAmount <= 0) continue;
      const amount = round2(Math.min(payment.unappliedAmount, invoice.balance, credit));
      if (amount <= 0) continue;
      applyToInvoice(invoice, amount, today);
      payment.allocations.push({ invoiceId: invoice._id, amount, source: 'CREDIT', appliedAt: new Date() });
      payment.unappliedAmount = round2(payment.unappliedAmount - amount);
      if (invoice.kind === 'DEPOSIT') tenant.depositCollected = round2((tenant.depositCollected || 0) + amount);
      credit = round2(credit - amount);
      applied = round2(applied + amount);
    }
    await invoice.save({ session: session || undefined });
  }
  for (const payment of payments) {
    if (payment.isModified()) await payment.save({ session: session || undefined });
  }
  tenant.creditBalance = credit;
  return applied;
};

/**
 * Create an invoice inside a session and immediately settle what the
 * tenant's advance credit covers.
 */
const createInvoice = async (
  { org, tenant, kind, lines, issueDate, dueDate, period = null, rentId = null, propertyId, notes = '', createdBy = null },
  session,
) => {
  const organizationId = org._id;
  const today = orgToday(org);
  const totals = billing.invoiceTotals(lines);
  const invoiceNumber = await nextNumber(
    organizationId,
    'INV',
    (org.settings && org.settings.invoicePrefix) || 'INV',
    session,
    issueDate,
  );
  const base = {
    organizationId,
    invoiceNumber,
    tenantId: tenant._id,
    propertyId: propertyId || (tenant.current && tenant.current.propertyId),
    rentId,
    kind,
    periodKey: period ? period.periodKey : null,
    periodStart: period ? period.periodStart : null,
    periodEnd: period ? period.periodEnd : null,
    // One RENT invoice per stay (Rent) per period; a returning tenant's new
    // stay gets a new Rent id and therefore its own lock.
    periodLock: kind === 'RENT' && period ? `${rentId || tenant._id}:${period.periodKey}` : null,
    issueDate,
    dueDate,
    lines,
    ...totals,
    amountPaid: 0,
    balance: totals.total,
    notes,
    createdBy,
  };
  const status = billing.deriveInvoiceStatus({ ...base, status: 'PENDING' }, today, 0);
  const [invoice] = await RentInvoice.create(
    [{ ...base, status, paidAt: status === 'PAID' ? new Date() : null }],
    { session: session || undefined },
  );
  if (invoice.balance > 0) await applyCredit({ organizationId, tenant, invoices: [invoice], today }, session);
  return invoice;
};

/**
 * Generate every rent invoice that is due for an organization, advancing
 * each Rent's billing cursor one period at a time. Idempotent and safe to
 * run concurrently: the cursor advance is conditional and the
 * one-invoice-per-period unique index is the final guard.
 */
const generateDueInvoices = async (organizationId, { now = new Date(), maxPeriodsPerRent = 12 } = {}) => {
  const org = await Organization.findById(organizationId).lean();
  if (!org || org.status !== 'ACTIVE') return { created: 0 };
  const today = orgToday(org, now);
  const rents = await Rent.find({ organizationId, status: 'ACTIVE', nextBillingDate: { $lte: today } })
    .select('_id')
    .lean();
  const created = [];

  for (const { _id: rentId } of rents) {
    for (let i = 0; i < maxPeriodsPerRent; i += 1) {
      let outcome;
      try {
        outcome = await withTransaction(async session => {
          const rent = await Rent.findOne({ _id: rentId, organizationId, status: 'ACTIVE' }).session(session);
          if (!rent || rent.nextBillingDate > today) return { stop: true };
          const period = billing.fullPeriod(rent.nextBillingDate);
          if (rent.endDate && period.periodStart > rent.endDate) return { stop: true };
          const advanced = await Rent.updateOne(
            { _id: rent._id, organizationId, nextBillingDate: rent.nextBillingDate },
            { $set: { nextBillingDate: period.nextBillingDate } },
            { session: session || undefined },
          );
          if (!advanced.modifiedCount) return { stop: true };
          const lock = `${rent._id}:${period.periodKey}`;
          if (await RentInvoice.exists({ organizationId, periodLock: lock }).session(session)) return { skipped: true };
          const tenant = await Tenant.findOne({ _id: rent.tenantId, organizationId }).session(session);
          if (!tenant) return { stop: true };
          const invoice = await createInvoice(
            {
              org,
              tenant,
              kind: 'RENT',
              lines: billing.buildRentLines(rent, period),
              issueDate: period.periodStart,
              dueDate: D.addDays(period.periodStart, rent.dueDays),
              period,
              rentId: rent._id,
              propertyId: rent.propertyId,
            },
            session,
          );
          await tenant.save({ session: session || undefined });
          return { invoice: invoice.toJSON(), userId: tenant.userId };
        });
      } catch (e) {
        if (e && e.code === 11000) continue; // raced with another generator
        throw e;
      }
      if (outcome.stop) break;
      if (outcome.invoice) created.push(outcome);
    }
  }

  for (const { invoice, userId } of created) {
    if (!userId || invoice.status === 'PAID') continue;
    notify({
      userIds: [userId],
      organizationId,
      type: 'invoice',
      title: `Rent invoice ${invoice.invoiceNumber}`,
      body: `${formatINR(invoice.balance)} due by ${D.dayKey(invoice.dueDate)}.`,
      data: { route: 'invoice', id: invoice.id },
    });
  }
  return { created: created.length };
};

/** Mark overdue invoices and accrue late fees per the org policy. */
const refreshOverdue = async (organizationId, { now = new Date() } = {}) => {
  const org = await Organization.findById(organizationId).lean();
  if (!org) return { overdue: 0, updated: 0 };
  const today = orgToday(org, now);
  const policy = (org.settings && org.settings.lateFee) || { type: 'NONE' };
  const invoices = await RentInvoice.find({
    organizationId,
    status: { $in: OPEN_STATUSES },
    balance: { $gt: 0 },
    dueDate: { $lt: today },
  });

  let updated = 0;
  const newlyOverdue = [];
  for (const invoice of invoices) {
    const before = invoice.status;
    if (['RENT', 'ADHOC'].includes(invoice.kind) && !invoice.lateFeeWaived) {
      const fee = billing.computeLateFee(policy, invoice.dueDate, today);
      const line = invoice.lines.find(l => l.type === 'LATE_FEE');
      const current = line ? line.amount : 0;
      if (fee > current) {
        if (line) line.amount = fee;
        else invoice.lines.push({ type: 'LATE_FEE', description: 'Late payment fee', amount: fee });
        invoice.lateFeeAppliedAt = now;
      }
    }
    recalcInvoice(invoice, today);
    if (invoice.isModified()) {
      try {
        await invoice.save();
        updated += 1;
        if (before !== 'OVERDUE' && invoice.status === 'OVERDUE') newlyOverdue.push(invoice);
      } catch (e) {
        if (e.name !== 'VersionError') throw e; // paid concurrently — next run catches up
      }
    }
  }

  if (newlyOverdue.length) {
    const tenants = await Tenant.find({
      organizationId,
      _id: { $in: newlyOverdue.map(i => i.tenantId) },
      userId: { $ne: null },
    })
      .select('userId')
      .lean();
    const userOf = new Map(tenants.map(t => [t._id, t.userId]));
    for (const inv of newlyOverdue) {
      const userId = userOf.get(inv.tenantId);
      if (!userId) continue;
      notify({
        userIds: [userId],
        organizationId,
        type: 'rent_reminder',
        title: 'Rent overdue',
        body: `Invoice ${inv.invoiceNumber} is overdue. ${formatINR(inv.balance)} outstanding.`,
        data: { route: 'invoice', id: inv._id },
        channels: ['inapp', 'push', 'sms'],
      });
    }
  }
  return { overdue: newlyOverdue.length, updated };
};

/** Remind tenants a few days before rent is due (once per invoice). */
const sendRentReminders = async (organizationId, { now = new Date() } = {}) => {
  const org = await Organization.findById(organizationId).lean();
  if (!org) return { reminded: 0 };
  const today = orgToday(org, now);
  const days = (org.settings && org.settings.rentReminderDaysBefore) || 0;
  if (days <= 0) return { reminded: 0 };
  const due = await RentInvoice.find({
    organizationId,
    status: { $in: ['PENDING', 'PARTIALLY_PAID'] },
    balance: { $gt: 0 },
    remindedAt: null,
    dueDate: { $gte: today, $lte: D.addDays(today, days) },
  }).lean();
  if (!due.length) return { reminded: 0 };
  const tenants = await Tenant.find({
    organizationId,
    _id: { $in: due.map(i => i.tenantId) },
    userId: { $ne: null },
  })
    .select('userId')
    .lean();
  const userOf = new Map(tenants.map(t => [t._id, t.userId]));
  let reminded = 0;
  for (const inv of due) {
    const claimed = await RentInvoice.updateOne(
      { _id: inv._id, organizationId, remindedAt: null },
      { $set: { remindedAt: now } },
    );
    if (!claimed.modifiedCount) continue;
    const userId = userOf.get(inv.tenantId);
    if (!userId) continue;
    reminded += 1;
    notify({
      userIds: [userId],
      organizationId,
      type: 'rent_reminder',
      title: 'Rent due soon',
      body: `${formatINR(inv.balance)} for ${inv.invoiceNumber} is due on ${D.dayKey(inv.dueDate)}.`,
      data: { route: 'invoice', id: inv._id },
      channels: ['inapp', 'push', 'whatsapp'],
    });
  }
  return { reminded };
};

module.exports = {
  OPEN_STATUSES,
  orgToday,
  applyToInvoice,
  recalcInvoice,
  applyCredit,
  createInvoice,
  generateDueInvoices,
  refreshOverdue,
  sendRentReminders,
};
