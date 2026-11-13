const Tenant = require('../models/Tenant');
const Rent = require('../models/Rent');
const RentInvoice = require('../models/RentInvoice');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const CheckOut = require('../models/CheckOut');
const TenantAgreement = require('../models/TenantAgreement');
const BedAllocation = require('../models/BedAllocation');
const { closeAllocation } = require('./allocation');
const { createInvoice, applyCredit, applyToInvoice, orgToday, OPEN_STATUSES } = require('./invoices');
const billing = require('./billing');
const { withTransaction } = require('../../core/tx');
const { nextNumber } = require('../../core/counters');
const { loadOwned } = require('../../core/refs');
const { audit } = require('../../core/audit');
const { round2, max0 } = require('../../core/money');
const D = require('../../core/dates');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');
const { formatINR } = require('./format');

const depositHeldOf = tenant =>
  max0((tenant.depositCollected || 0) - (tenant.depositAdjusted || 0) - (tenant.depositRefunded || 0));

/** Gather settlement inputs (optionally inside a session). */
const settlementInputs = async ({ organizationId, tenant, dto, org }, session = null) => {
  const rent = tenant.current && tenant.current.rentId
    ? await Rent.findOne({ _id: tenant.current.rentId, organizationId }).session(session).lean()
    : null;
  const open = await RentInvoice.find({
    organizationId,
    tenantId: tenant._id,
    status: { $in: OPEN_STATUSES },
    balance: { $gt: 0 },
  })
    .session(session)
    .lean();
  const settings = org.settings || {};
  return {
    rent,
    open,
    input: {
      checkoutDate: dto.checkoutDate,
      monthlyRent: rent ? rent.monthlyRent : tenant.monthlyRent,
      charges: rent ? rent.charges : [],
      discount: rent ? rent.discount : null,
      nextBillingDate: rent ? rent.nextBillingDate : null,
      // An unpaid security deposit is voided at checkout, not collected.
      openInvoices: open
        .filter(i => i.kind !== 'DEPOSIT')
        .map(i => ({ id: i._id, invoiceNumber: i.invoiceNumber, balance: i.balance })),
      electricity: dto.electricity || 0,
      damages: dto.damages || [],
      otherCharges: dto.otherCharges || [],
      depositHeld: depositHeldOf(tenant),
      creditBalance: tenant.creditBalance || 0,
      notice: {
        noticePeriodDays: tenant.noticePeriodDays,
        noticeGivenAt: tenant.noticeGivenAt,
        chargeShortfall: dto.waiveNoticeShortfall ? false : settings.chargeNoticeShortfall !== false,
      },
    },
  };
};

const loadCheckedInTenant = async (req, tenantId) => {
  const tenant = await loadOwned(Tenant, tenantId, req, { entity: 'Tenant', propertyField: 'current.propertyId', lean: true });
  if (!['ACTIVE', 'NOTICE'].includes(tenant.status) || !tenant.current || !tenant.current.allocationId) {
    throw errors.conflict('This tenant is not currently checked in.', 'TENANT_NOT_CHECKED_IN');
  }
  return tenant;
};

const previewCheckout = async (req, tenantId, dto) => {
  const tenant = await loadCheckedInTenant(req, tenantId);
  const checkoutDate = D.toDay(dto.checkoutDate);
  if (tenant.joiningDate && checkoutDate < D.toDay(tenant.joiningDate)) {
    throw errors.badRequest('Checkout date cannot be before the joining date.', 'VALIDATION_ERROR');
  }
  const { input, open } = await settlementInputs({ organizationId: req.ctx.orgId, tenant, dto, org: req.ctx.org });
  return {
    tenant: { id: tenant._id, fullName: tenant.fullName },
    openInvoices: open
      .filter(i => i.kind !== 'DEPOSIT')
      .map(i => ({ id: i._id, invoiceNumber: i.invoiceNumber, kind: i.kind, dueDate: i.dueDate, balance: i.balance })),
    ...billing.computeSettlement(input),
  };
};

/**
 * Execute checkout: final invoice, credit & deposit adjustment, refunds,
 * close the stay and release the bed — all or nothing.
 */
const executeCheckout = async (req, tenantId, dto) => {
  const organizationId = req.ctx.orgId;
  const org = req.ctx.org;
  const tenant0 = await loadCheckedInTenant(req, tenantId);
  const checkoutDate = D.toDay(dto.checkoutDate);
  if (tenant0.joiningDate && checkoutDate < D.toDay(tenant0.joiningDate)) {
    throw errors.badRequest('Checkout date cannot be before the joining date.', 'VALIDATION_ERROR');
  }

  const result = await withTransaction(async session => {
    const tenant = await Tenant.findOne({ _id: tenant0._id, organizationId }).session(session);
    if (!tenant || !['ACTIVE', 'NOTICE'].includes(tenant.status)) {
      throw errors.conflict('This tenant is not currently checked in.', 'TENANT_NOT_CHECKED_IN');
    }
    const today = orgToday(org);
    const { rent, input } = await settlementInputs({ organizationId, tenant, dto, org }, session);
    const s = billing.computeSettlement(input);

    // 1. Final charges invoice.
    let settlementInvoice = null;
    if (s.newLines.length && s.newCharges > 0) {
      settlementInvoice = await createInvoice(
        {
          org,
          tenant,
          kind: 'SETTLEMENT',
          lines: s.newLines,
          issueDate: checkoutDate,
          dueDate: checkoutDate,
          propertyId: tenant.current.propertyId,
          notes: 'Final settlement at checkout',
          createdBy: req.user._id,
        },
        session,
      );
    }

    // 2. Advance credit against every open invoice (oldest first).
    const openDocs = await RentInvoice.find({
      organizationId,
      tenantId: tenant._id,
      status: { $in: OPEN_STATUSES },
      balance: { $gt: 0 },
    })
      .sort({ dueDate: 1 })
      .session(session);
    await applyCredit({ organizationId, tenant, invoices: openDocs.filter(i => i.kind !== 'DEPOSIT'), today }, session);

    // 3. Security deposit against what is still due.
    const stillOpen = openDocs.filter(i => i.balance > 0 && i.kind !== 'DEPOSIT');
    const dues = round2(stillOpen.reduce((t, i) => t + i.balance, 0));
    const held = depositHeldOf(tenant);
    const depositApplied = round2(Math.min(held, dues));
    let adjustment = null;
    if (depositApplied > 0) {
      adjustment = new Payment({
        organizationId,
        receiptNumber: await nextNumber(organizationId, 'RCPT', (org.settings && org.settings.receiptPrefix) || 'RCPT', session),
        tenantId: tenant._id,
        propertyId: tenant.current.propertyId,
        amount: depositApplied,
        method: 'DEPOSIT_ADJUSTMENT',
        status: 'SUCCEEDED',
        paidAt: new Date(),
        source: 'SYSTEM',
        recordedBy: req.user._id,
        notes: 'Security deposit adjusted at checkout',
      });
      let remaining = depositApplied;
      for (const invoice of stillOpen) {
        if (remaining <= 0) break;
        const amount = round2(Math.min(remaining, invoice.balance));
        applyToInvoice(invoice, amount, today);
        await invoice.save({ session: session || undefined });
        adjustment.allocations.push({ invoiceId: invoice._id, amount, source: 'PAYMENT' });
        remaining = round2(remaining - amount);
      }
      adjustment.unappliedAmount = 0;
      await adjustment.save({ session: session || undefined });
      tenant.depositAdjusted = round2((tenant.depositAdjusted || 0) + depositApplied);
    }

    // Unpaid deposit invoice is void once the tenant leaves.
    for (const invoice of openDocs.filter(i => i.kind === 'DEPOSIT' && i.balance > 0)) {
      invoice.status = 'CANCELLED';
      invoice.cancelledAt = new Date();
      invoice.cancelledBy = req.user._id;
      invoice.cancelReason = 'Tenant checked out';
      await invoice.save({ session: session || undefined });
    }

    // 4. Refunds of whatever deposit / advance remains.
    const refundIds = [];
    const refundDeposit = depositHeldOf(tenant);
    const refundCredit = round2(tenant.creditBalance || 0);
    const makeRefund = async (type, amount, extra = {}) => {
      const [doc] = await Refund.create(
        [
          {
            organizationId,
            refundNumber: await nextNumber(organizationId, 'RFND', 'RFND', session),
            tenantId: tenant._id,
            type,
            amount,
            reason: type === 'DEPOSIT_REFUND' ? 'Security deposit refund at checkout' : 'Unused advance refund at checkout',
            createdBy: req.user._id,
            ...extra,
          },
        ],
        { session: session || undefined },
      );
      refundIds.push(doc._id);
      return doc;
    };
    if (refundDeposit > 0) {
      await makeRefund('DEPOSIT_REFUND', refundDeposit);
      tenant.depositRefunded = round2((tenant.depositRefunded || 0) + refundDeposit);
    }
    if (refundCredit > 0) {
      await makeRefund('ADVANCE_REFUND', refundCredit);
      // Consume the unapplied balances the refund pays back.
      let left = refundCredit;
      const credits = await Payment.find({ organizationId, tenantId: tenant._id, unappliedAmount: { $gt: 0 } })
        .sort({ paidAt: 1 })
        .session(session);
      for (const p of credits) {
        if (left <= 0) break;
        const take = round2(Math.min(left, p.unappliedAmount));
        p.unappliedAmount = round2(p.unappliedAmount - take);
        p.refundedAmount = round2((p.refundedAmount || 0) + take);
        p.status = p.refundedAmount >= p.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        await p.save({ session: session || undefined });
        left = round2(left - take);
      }
      tenant.creditBalance = 0;
    }

    // 5. Close the stay: allocation, bed, rent, agreement, tenant.
    const allocation = await closeAllocation(
      { organizationId, allocationId: tenant.current.allocationId, tenantId: tenant._id, endDate: checkoutDate, reason: 'CHECKOUT' },
      session,
    );
    if (rent) {
      await Rent.updateOne(
        { _id: rent._id, organizationId },
        { $set: { status: 'ENDED', endDate: checkoutDate } },
        { session: session || undefined },
      );
    }
    if (tenant.current.agreementId) {
      await TenantAgreement.updateOne(
        { _id: tenant.current.agreementId, organizationId, status: 'ACTIVE' },
        { $set: { status: 'ENDED', endedAt: new Date(), endDate: checkoutDate } },
        { session: session || undefined },
      );
    }

    const amountDue = round2(
      (
        await RentInvoice.find({ organizationId, tenantId: tenant._id, status: { $in: OPEN_STATUSES }, balance: { $gt: 0 } })
          .session(session)
          .lean()
      ).reduce((t, i) => t + i.balance, 0),
    );

    const [checkOutDoc] = await CheckOut.create(
      [
        {
          organizationId,
          checkOutNumber: await nextNumber(organizationId, 'CHKOUT', 'CHKOUT', session),
          tenantId: tenant._id,
          propertyId: allocation.propertyId,
          roomId: allocation.roomId,
          bedId: allocation.bedId,
          allocationId: allocation._id,
          checkoutDate,
          reason: dto.reason || '',
          settlement: { ...s, depositApplied, refundDeposit, refundCredit, amountDue },
          settlementInvoiceId: settlementInvoice ? settlementInvoice._id : null,
          depositAdjustmentPaymentId: adjustment ? adjustment._id : null,
          refundIds,
          amountDue,
          refundTotal: round2(refundDeposit + refundCredit),
          performedBy: req.user._id,
          notes: dto.notes || '',
        },
      ],
      { session: session || undefined },
    );

    await BedAllocation.updateOne(
      { _id: allocation._id, organizationId },
      { $set: { checkOutId: checkOutDoc._id } },
      { session: session || undefined },
    );

    tenant.status = 'CHECKED_OUT';
    tenant.checkedOutAt = checkoutDate;
    tenant.expectedCheckoutDate = null;
    tenant.current = { propertyId: allocation.propertyId };
    await tenant.save({ session: session || undefined });

    return { checkOut: checkOutDoc.toJSON(), tenant: tenant.toJSON() };
  });

  const co = result.checkOut;
  audit(req, {
    action: 'checkout.create',
    entityType: 'CheckOut',
    entityId: co.id,
    summary: `${result.tenant.fullName} checked out · refund ${formatINR(co.refundTotal)} · due ${formatINR(co.amountDue)}`,
  });
  if (result.tenant.userId) {
    notify({
      userIds: [result.tenant.userId],
      organizationId,
      type: 'checkout',
      title: 'Checkout complete',
      body:
        co.amountDue > 0
          ? `Final settlement: ${formatINR(co.amountDue)} payable.`
          : co.refundTotal > 0
          ? `Final settlement: ${formatINR(co.refundTotal)} will be refunded to you.`
          : 'Your final settlement is complete. Thank you for staying with us!',
      data: { route: 'checkout', id: co.id },
    });
  }
  return result;
};

module.exports = { previewCheckout, executeCheckout, depositHeldOf };
