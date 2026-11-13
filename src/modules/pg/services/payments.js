const env = require('../../../config/env');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const RentInvoice = require('../models/RentInvoice');
const Tenant = require('../models/Tenant');
const Organization = require('../../saas/models/Organization');
const { applyToInvoice, orgToday, OPEN_STATUSES } = require('./invoices');
const { getGateway } = require('../../payments/gateway');
const { assertFeature } = require('../../saas/services/entitlements');
const { memberUserIdsForProperty } = require('../../saas/services/members');
const { withTransaction } = require('../../core/tx');
const { unscoped } = require('../../core/scope');
const { nextNumber } = require('../../core/counters');
const { round2, sum } = require('../../core/money');
const { loadOwned } = require('../../core/refs');
const { audit } = require('../../core/audit');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');
const { track } = require('../../analytics/track');
const { formatINR } = require('./format');

/**
 * Allocate a payment across the tenant's open invoices — preferred ones
 * first, then oldest due — and park any remainder as advance credit.
 * Mutates `payment` and `tenant`; saves the invoices it touches.
 */
const allocatePayment = async ({ organizationId, payment, tenant, preferredInvoiceIds = [], today }, session) => {
  let remaining = round2(payment.amount - sum((payment.allocations || []).map(a => a.amount)));
  const open = await RentInvoice.find({
    organizationId,
    tenantId: tenant._id,
    status: { $in: OPEN_STATUSES },
    balance: { $gt: 0 },
  })
    .sort({ dueDate: 1, createdAt: 1 })
    .session(session);

  const preferred = preferredInvoiceIds.map(String);
  const ordered = [
    ...preferred.map(id => open.find(i => i._id === id)).filter(Boolean),
    ...open.filter(i => !preferred.includes(i._id)),
  ];

  for (const invoice of ordered) {
    if (remaining <= 0) break;
    const amount = round2(Math.min(remaining, invoice.balance));
    if (amount <= 0) continue;
    applyToInvoice(invoice, amount, today);
    await invoice.save({ session: session || undefined });
    payment.allocations.push({ invoiceId: invoice._id, amount, source: 'PAYMENT', appliedAt: new Date() });
    if (invoice.kind === 'DEPOSIT') tenant.depositCollected = round2((tenant.depositCollected || 0) + amount);
    remaining = round2(remaining - amount);
  }
  payment.unappliedAmount = remaining;
  tenant.creditBalance = round2((tenant.creditBalance || 0) + remaining);
};

const receiptPrefix = org => (org.settings && org.settings.receiptPrefix) || 'RCPT';

/** Staff recording cash / UPI / bank transfer / card money. */
const recordOfflinePayment = async (req, dto) => {
  const organizationId = req.ctx.orgId;
  await loadOwned(Tenant, dto.tenantId, req, { entity: 'Tenant', propertyField: 'current.propertyId', lean: true });

  if (dto.idempotencyKey) {
    const existing = await Payment.findOne({ organizationId, idempotencyKey: dto.idempotencyKey }).lean();
    if (existing) return { payment: existing, duplicate: true };
  }

  const org = req.ctx.org;
  const today = orgToday(org);
  let result;
  try {
    result = await withTransaction(async session => {
      const tenant = await Tenant.findOne({ _id: dto.tenantId, organizationId }).session(session);
      if (!tenant) throw errors.notFound('Tenant');
      const payment = new Payment({
        organizationId,
        receiptNumber: await nextNumber(organizationId, 'RCPT', receiptPrefix(org), session),
        tenantId: tenant._id,
        propertyId: tenant.current && tenant.current.propertyId,
        amount: dto.amount,
        method: dto.method,
        status: 'SUCCEEDED',
        reference: dto.reference || '',
        paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
        source: 'STAFF',
        recordedBy: req.user._id,
        idempotencyKey: dto.idempotencyKey || null,
        notes: dto.notes || '',
      });
      await allocatePayment(
        { organizationId, payment, tenant, preferredInvoiceIds: dto.invoiceIds || [], today },
        session,
      );
      await payment.save({ session: session || undefined });
      await tenant.save({ session: session || undefined });
      return { payment: payment.toJSON(), tenant: tenant.toJSON() };
    });
  } catch (e) {
    if (e && e.code === 11000 && dto.idempotencyKey) {
      const existing = await Payment.findOne({ organizationId, idempotencyKey: dto.idempotencyKey }).lean();
      if (existing) return { payment: existing, duplicate: true };
    }
    throw e;
  }

  audit(req, {
    action: 'payment.record',
    entityType: 'Payment',
    entityId: result.payment.id,
    summary: `${dto.method} payment of ${formatINR(dto.amount)} recorded`,
  });
  track('payment_completed', {
    userId: req.user._id,
    organizationId,
    props: { method: dto.method, amount: dto.amount, channel: 'offline' },
  });
  if (result.tenant.userId) {
    notify({
      userIds: [result.tenant.userId],
      organizationId,
      type: 'payment_confirmation',
      title: 'Payment received',
      body: `${formatINR(dto.amount)} received (${result.payment.receiptNumber}). Thank you!`,
      data: { route: 'payment', id: result.payment.id },
    });
  }
  return { payment: result.payment, duplicate: false };
};

/** Tenant starts an online payment for their open invoices. */
const initiateOnlinePayment = async (req, { invoiceIds }) => {
  const organizationId = req.ctx.orgId;
  await assertFeature(organizationId, 'onlinePayments');
  const gateway = getGateway();
  if (!gateway.isConfigured()) {
    throw errors.unavailable('Online payments are temporarily unavailable. Please pay at the front desk.', 'PAYMENTS_NOT_CONFIGURED');
  }

  const tenant = await Tenant.findOne({ _id: req.ctx.tenantId, organizationId }).lean();
  if (!tenant) throw errors.notFound('Tenant');
  const filter = { organizationId, tenantId: tenant._id, status: { $in: OPEN_STATUSES }, balance: { $gt: 0 } };
  if (invoiceIds && invoiceIds.length) filter._id = { $in: invoiceIds };
  const invoices = await RentInvoice.find(filter).sort({ dueDate: 1 }).lean();
  if (invoiceIds && invoiceIds.length && invoices.length !== new Set(invoiceIds).size) {
    throw errors.badRequest('Some selected invoices are already paid or do not belong to you.', 'INVOICE_NOT_PAYABLE');
  }
  // The amount is computed here from our own ledger — never from the client.
  const amount = sum(invoices.map(i => i.balance));
  if (!(amount > 0)) throw errors.badRequest('There is nothing due right now.', 'NOTHING_TO_PAY');
  const ids = invoices.map(i => i._id).sort();

  const reusable = await Payment.findOne({
    organizationId,
    tenantId: tenant._id,
    status: 'PENDING',
    method: 'ONLINE',
    amount,
    invoiceIds: { $size: ids.length, $all: ids },
    'gateway.expiresAt': { $gt: new Date(Date.now() + 5 * 60 * 1000) },
  }).lean();
  if (reusable && reusable.gateway && reusable.gateway.checkoutUrl) {
    return {
      paymentId: reusable._id,
      checkoutUrl: reusable.gateway.checkoutUrl,
      amount: reusable.amount,
      expiresAt: reusable.gateway.expiresAt,
    };
  }

  const payment = await Payment.create({
    organizationId,
    tenantId: tenant._id,
    propertyId: tenant.current && tenant.current.propertyId,
    amount,
    method: 'ONLINE',
    status: 'PENDING',
    invoiceIds: ids,
    source: 'TENANT_APP',
  });

  const expiresAt = new Date(Date.now() + env.PAYMENT_LINK_EXPIRY_MINUTES * 60 * 1000);
  let checkout;
  try {
    checkout = await gateway.createCheckout({
      referenceId: payment._id,
      amount,
      description: `Rent payment — ${req.ctx.org.name}`,
      customer: { name: tenant.fullName, phone: tenant.phone, email: tenant.email },
      notes: { kind: 'rent', organizationId, paymentId: payment._id },
      callbackUrl: `${env.PUBLIC_API_URL}/api/payments/return`,
      expireBy: expiresAt,
    });
  } catch (e) {
    await Payment.updateOne({ _id: payment._id, organizationId }, { $set: { status: 'FAILED', failureReason: e.message } });
    throw e;
  }
  await Payment.updateOne(
    { _id: payment._id, organizationId },
    { $set: { gateway: { provider: gateway.name, ref: checkout.ref, checkoutUrl: checkout.url, expiresAt, lastStatus: checkout.status } } },
  );
  track('payment_initiated', { userId: req.user._id, organizationId, props: { amount, invoices: ids.length } });
  return { paymentId: payment._id, checkoutUrl: checkout.url, amount, expiresAt };
};

/**
 * The ONLY way an online payment becomes SUCCEEDED: called with data from
 * a signature-verified webhook or a server-to-server gateway status check.
 * Idempotent — duplicates and concurrent deliveries credit exactly once.
 */
const confirmOnlinePayment = async ({ ref, amountPaid, currency, gatewayPaymentId }) => {
  const payment = await unscoped(() => Payment.findOne({ 'gateway.ref': ref }).lean());
  if (!payment) return { matched: false };
  if (payment.status === 'SUCCEEDED') return { matched: true, duplicate: true, paymentId: payment._id };
  const organizationId = payment.organizationId;

  if (round2(amountPaid) !== round2(payment.amount) || String(currency || 'INR') !== 'INR') {
    await Payment.updateOne(
      { _id: payment._id, organizationId, status: { $in: ['PENDING', 'EXPIRED', 'CANCELLED'] } },
      { $set: { status: 'FAILED', failureReason: `Amount mismatch: gateway reported ${amountPaid} ${currency}, expected ${payment.amount} INR` } },
    );
    console.error('[payments] amount mismatch — manual review needed', payment._id);
    return { matched: true, mismatch: true, paymentId: payment._id };
  }

  const org = await Organization.findById(organizationId).lean();
  const today = orgToday(org);
  const result = await withTransaction(async session => {
    // Money that actually arrived wins over a local expiry.
    const claimed = await Payment.findOneAndUpdate(
      { _id: payment._id, organizationId, status: { $in: ['PENDING', 'EXPIRED', 'CANCELLED'] } },
      {
        $set: {
          status: 'SUCCEEDED',
          paidAt: new Date(),
          'gateway.paymentId': gatewayPaymentId || null,
          'gateway.lastStatus': 'paid',
        },
      },
      { new: true, session: session || undefined },
    );
    if (!claimed) return null;
    const tenant = await Tenant.findOne({ _id: claimed.tenantId, organizationId }).session(session);
    claimed.receiptNumber = await nextNumber(organizationId, 'RCPT', receiptPrefix(org), session);
    if (tenant) {
      await allocatePayment(
        { organizationId, payment: claimed, tenant, preferredInvoiceIds: claimed.invoiceIds || [], today },
        session,
      );
      await tenant.save({ session: session || undefined });
    }
    await claimed.save({ session: session || undefined });
    return { payment: claimed.toJSON(), tenantUserId: tenant ? tenant.userId : null };
  });

  if (!result) return { matched: true, duplicate: true, paymentId: payment._id };

  const p = result.payment;
  audit(null, {
    organizationId,
    action: 'payment.online.confirmed',
    entityType: 'Payment',
    entityId: p.id,
    summary: `Online payment ${formatINR(p.amount)} verified with gateway`,
  });
  track('payment_completed', { userId: result.tenantUserId, organizationId, props: { method: 'ONLINE', amount: p.amount, channel: 'online' } });
  if (result.tenantUserId) {
    notify({
      userIds: [result.tenantUserId],
      organizationId,
      type: 'payment_confirmation',
      title: 'Payment successful',
      body: `${formatINR(p.amount)} received (${p.receiptNumber}). Your receipt is ready.`,
      data: { route: 'payment', id: p.id },
    });
  }
  memberUserIdsForProperty(organizationId, ['OWNER', 'ACCOUNTANT', 'PROPERTY_MANAGER'], p.propertyId)
    .then(userIds =>
      notify({
        userIds,
        organizationId,
        type: 'payment_confirmation',
        title: 'Online rent received',
        body: `${formatINR(p.amount)} received online (${p.receiptNumber}).`,
        data: { route: 'payment', id: p.id },
        channels: ['inapp', 'push'],
      }),
    )
    .catch(() => {});
  return { matched: true, confirmed: true, paymentId: p.id };
};

const closeOnlineCheckout = async (ref, status) => {
  const payment = await unscoped(() => Payment.findOne({ 'gateway.ref': ref }).lean());
  if (!payment) return { matched: false };
  await Payment.updateOne(
    { _id: payment._id, organizationId: payment.organizationId, status: 'PENDING' },
    { $set: { status: status === 'expired' ? 'EXPIRED' : 'CANCELLED', 'gateway.lastStatus': status } },
  );
  return { matched: true };
};

/** Server-to-server check of a pending online payment (never trusts the app). */
const reconcilePayment = async (organizationId, paymentId) => {
  const payment = await Payment.findOne({ _id: paymentId, organizationId }).lean();
  if (!payment) throw errors.notFound('Payment');
  if (payment.method !== 'ONLINE' || !['PENDING', 'EXPIRED'].includes(payment.status) || !payment.gateway || !payment.gateway.ref) {
    return payment;
  }
  const gateway = getGateway();
  if (!gateway.isConfigured()) return payment;
  try {
    const remote = await gateway.fetchCheckout(payment.gateway.ref);
    if (remote.status === 'paid') {
      await confirmOnlinePayment({
        ref: payment.gateway.ref,
        amountPaid: remote.amountPaid,
        currency: remote.currency,
        gatewayPaymentId: remote.gatewayPaymentId,
      });
    } else if (remote.status === 'expired' || remote.status === 'cancelled') {
      await closeOnlineCheckout(payment.gateway.ref, remote.status);
    }
  } catch (e) {
    console.warn('[payments] reconcile failed', e.message);
  }
  return Payment.findOne({ _id: paymentId, organizationId }).lean();
};

/** Expire / reconcile stale pending online payments (job). */
const sweepPendingPayments = async organizationId => {
  const stale = await Payment.find({
    organizationId,
    status: 'PENDING',
    method: 'ONLINE',
    'gateway.expiresAt': { $lt: new Date() },
  })
    .select('_id')
    .lean();
  for (const p of stale) {
    const after = await reconcilePayment(organizationId, p._id);
    if (after && after.status === 'PENDING') {
      await Payment.updateOne({ _id: p._id, organizationId, status: 'PENDING' }, { $set: { status: 'EXPIRED' } });
    }
  }
  return { swept: stale.length };
};

/**
 * Refund the unallocated (advance / overpaid) part of a payment. Money
 * already applied to invoices must be handled by cancelling / crediting
 * those invoices first.
 */
const refundPayment = async (req, paymentId, { amount, reason, method, reference }) => {
  const organizationId = req.ctx.orgId;
  const payment = await loadOwned(Payment, paymentId, req, { entity: 'Payment' });
  if (!['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(payment.status) || payment.method === 'DEPOSIT_ADJUSTMENT') {
    throw errors.conflict('This payment cannot be refunded.', 'NOT_REFUNDABLE');
  }
  if (amount > payment.unappliedAmount) {
    throw errors.conflict(
      `Only the unallocated ${formatINR(payment.unappliedAmount)} can be refunded. Adjust invoices first to refund more.`,
      'REFUND_EXCEEDS_UNALLOCATED',
      { refundable: payment.unappliedAmount },
    );
  }

  const viaGateway = payment.method === 'ONLINE' && payment.gateway && payment.gateway.paymentId;
  let gatewayRefund = null;
  if (viaGateway) {
    gatewayRefund = await getGateway().refund(payment.gateway.paymentId, amount, { reason: reason || '' });
  }

  const refund = await withTransaction(async session => {
    const p = await Payment.findOne({ _id: payment._id, organizationId }).session(session);
    const tenant = await Tenant.findOne({ _id: p.tenantId, organizationId }).session(session);
    if (amount > p.unappliedAmount) throw errors.conflict('Refundable amount changed. Please retry.', 'CONCURRENT_UPDATE');
    p.unappliedAmount = round2(p.unappliedAmount - amount);
    p.refundedAmount = round2(p.refundedAmount + amount);
    p.status = p.refundedAmount >= p.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    await p.save({ session: session || undefined });
    if (tenant) {
      tenant.creditBalance = round2(Math.max(0, (tenant.creditBalance || 0) - amount));
      await tenant.save({ session: session || undefined });
    }
    const [doc] = await Refund.create(
      [
        {
          organizationId,
          refundNumber: await nextNumber(organizationId, 'RFND', 'RFND', session),
          tenantId: p.tenantId,
          paymentId: p._id,
          type: 'PAYMENT_REFUND',
          amount,
          status: viaGateway ? 'PROCESSING' : 'PROCESSED',
          method: viaGateway ? 'GATEWAY' : method || 'CASH',
          reference: reference || '',
          reason: reason || '',
          gatewayRefundId: gatewayRefund ? gatewayRefund.refundId : null,
          processedBy: viaGateway ? null : req.user._id,
          processedAt: viaGateway ? null : new Date(),
          createdBy: req.user._id,
        },
      ],
      { session: session || undefined },
    );
    return doc.toJSON();
  });

  audit(req, { action: 'payment.refund', entityType: 'Refund', entityId: refund.id, summary: `Refund ${formatINR(amount)} on ${payment.receiptNumber}` });
  return refund;
};

/** Mark a pending refund (checkout deposit / advance) as paid out. */
const processRefund = async (req, refundId, { method, reference }) => {
  const organizationId = req.ctx.orgId;
  const refund = await loadOwned(Refund, refundId, req, { entity: 'Refund', propertyField: null });
  if (refund.status !== 'PENDING') throw errors.conflict('This refund is not pending.', 'REFUND_STATE');
  const updated = await Refund.findOneAndUpdate(
    { _id: refund._id, organizationId, status: 'PENDING' },
    { $set: { status: 'PROCESSED', method, reference: reference || '', processedBy: req.user._id, processedAt: new Date() } },
    { new: true },
  ).lean();
  if (!updated) throw errors.conflict('This refund is not pending.', 'REFUND_STATE');
  audit(req, { action: 'refund.process', entityType: 'Refund', entityId: refund._id, summary: `Refund ${refund.refundNumber} paid via ${method}` });
  const tenant = await Tenant.findOne({ _id: refund.tenantId, organizationId }).select('userId').lean();
  if (tenant && tenant.userId) {
    notify({
      userIds: [tenant.userId],
      organizationId,
      type: 'payment_confirmation',
      title: 'Refund processed',
      body: `${formatINR(refund.amount)} has been refunded to you (${refund.refundNumber}).`,
      data: { route: 'refund', id: refund._id },
    });
  }
  return updated;
};

/** Gateway refund webhooks. */
const onGatewayRefund = async ({ refundId, type }) => {
  const refund = await unscoped(() => Refund.findOne({ gatewayRefundId: refundId }).lean());
  if (!refund) return { matched: false };
  await Refund.updateOne(
    { _id: refund._id, organizationId: refund.organizationId, status: 'PROCESSING' },
    { $set: { status: type === 'refund.processed' ? 'PROCESSED' : 'FAILED', processedAt: new Date() } },
  );
  return { matched: true };
};

module.exports = {
  allocatePayment,
  recordOfflinePayment,
  initiateOnlinePayment,
  confirmOnlinePayment,
  closeOnlineCheckout,
  reconcilePayment,
  sweepPendingPayments,
  refundPayment,
  processRefund,
  onGatewayRefund,
};
