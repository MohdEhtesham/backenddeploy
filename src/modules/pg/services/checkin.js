const Tenant = require('../models/Tenant');
const Bed = require('../models/Bed');
const Room = require('../models/Room');
const PgProperty = require('../models/PgProperty');
const Rent = require('../models/Rent');
const TenantAgreement = require('../models/TenantAgreement');
const CheckIn = require('../models/CheckIn');
const Payment = require('../models/Payment');
const Floor = require('../models/Floor');
const BedAllocation = require('../models/BedAllocation');
const { claimBed, openAllocation } = require('./allocation');
const { createInvoice, orgToday } = require('./invoices');
const { allocatePayment } = require('./payments');
const { findOrCreateUserByPhone, ensureMembership } = require('./accounts');
const billing = require('./billing');
const { assertLimit } = require('../../saas/services/entitlements');
const { withTransaction } = require('../../core/tx');
const { nextNumber } = require('../../core/counters');
const { loadOwned } = require('../../core/refs');
const { assertPropertyAccess } = require('../../core/context');
const { audit } = require('../../core/audit');
const D = require('../../core/dates');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');
const { formatINR } = require('./format');

const DEFAULT_TERMS = [
  'Rent is payable monthly in advance by the due date shown on each invoice.',
  'The security deposit is refundable at checkout after adjusting dues and damages.',
  'The notice period must be served before vacating; shortfall may be charged.',
  'Residents must follow the house rules of the property.',
].join('\n');

/**
 * Check a tenant into a bed. One transaction covers: bed claim (atomic),
 * occupancy record, recurring rent, agreement, deposit + first (prorated)
 * rent invoices, optional collection at the desk, tenant activation and
 * the tenant's app access.
 */
const checkIn = async (req, dto) => {
  const organizationId = req.ctx.orgId;
  const org = req.ctx.org;
  const settings = org.settings || {};

  const tenant0 = await loadOwned(Tenant, dto.tenantId, req, { entity: 'Tenant', propertyField: null, lean: true });
  if (['ACTIVE', 'NOTICE'].includes(tenant0.status)) {
    throw errors.conflict('This tenant is already checked in.', 'TENANT_ALREADY_CHECKED_IN');
  }
  if (settings.requireKycForCheckIn && tenant0.kycStatus !== 'VERIFIED') {
    throw errors.conflict('KYC must be verified before check-in.', 'KYC_REQUIRED');
  }
  const bed0 = await Bed.findOne({ _id: dto.bedId, organizationId }).lean();
  if (!bed0) throw errors.notFound('Bed');
  assertPropertyAccess(req, bed0.propertyId);
  const room = await Room.findOne({ _id: bed0.roomId, organizationId }).lean();
  if (!room || room.status !== 'ACTIVE') {
    throw errors.conflict('This room is not open for check-ins right now.', 'ROOM_UNAVAILABLE');
  }
  const property = await PgProperty.findOne({ _id: bed0.propertyId, organizationId }).lean();
  if (!property || property.status !== 'ACTIVE') throw errors.conflict('This property is inactive.', 'PROPERTY_INACTIVE');
  // A returning (checked-out) tenant becomes current again.
  if (tenant0.status === 'CHECKED_OUT') await assertLimit(organizationId, 'maxTenants', 1);

  const checkInDate = D.toDay(dto.checkInDate || orgToday(org));
  const monthlyRent = dto.monthlyRent ?? bed0.rent ?? room.rentPerBed;
  const depositAmount = dto.depositAmount ?? bed0.deposit ?? room.depositPerBed ?? 0;
  const billingDay = D.clampBillingDay(dto.billingDay ?? property.billingDay ?? settings.billingDay ?? 1);
  const dueDays = dto.dueDays ?? property.dueDays ?? settings.dueDays ?? 5;
  const noticePeriodDays = dto.agreement?.noticePeriodDays ?? settings.noticePeriodDays ?? 30;
  const charges = [...(dto.charges || [])];
  const messOptIn = dto.messOptIn ?? tenant0.messOptIn;
  if (messOptIn && property.messEnabled && property.messChargeMonthly > 0 && !charges.some(c => c.type === 'FOOD')) {
    charges.push({ type: 'FOOD', label: 'Mess charges', amount: property.messChargeMonthly });
  }
  const first = billing.firstPeriod(checkInDate, billingDay);
  const floor = await Floor.findOne({ _id: bed0.floorId, organizationId }).select('name').lean();

  const result = await withTransaction(async session => {
    const tenant = await Tenant.findOne({ _id: tenant0._id, organizationId }).session(session);
    if (!tenant || ['ACTIVE', 'NOTICE'].includes(tenant.status)) {
      throw errors.conflict('This tenant is already checked in.', 'TENANT_ALREADY_CHECKED_IN');
    }

    const bed = await claimBed(organizationId, bed0._id, tenant._id, session);
    const allocation = await openAllocation(
      { organizationId, bed, tenantId: tenant._id, startDate: checkInDate, monthlyRent },
      session,
    );

    const [rent] = await Rent.create(
      [
        {
          organizationId,
          tenantId: tenant._id,
          allocationId: allocation._id,
          propertyId: bed.propertyId,
          bedId: bed._id,
          monthlyRent,
          billingDay,
          dueDays,
          charges,
          discount: dto.discount || {},
          startDate: checkInDate,
          nextBillingDate: first.nextBillingDate,
        },
      ],
      { session: session || undefined },
    );

    const [agreement] = await TenantAgreement.create(
      [
        {
          organizationId,
          agreementNumber: await nextNumber(organizationId, 'AGR', 'AGR', session),
          tenantId: tenant._id,
          allocationId: allocation._id,
          propertyId: bed.propertyId,
          bedId: bed._id,
          startDate: checkInDate,
          endDate: dto.agreement?.endDate ? D.toDay(dto.agreement.endDate) : null,
          monthlyRent,
          depositAmount,
          lockInMonths: dto.agreement?.lockInMonths ?? 0,
          noticePeriodDays,
          terms: dto.agreement?.terms || DEFAULT_TERMS,
          status: 'ACTIVE',
        },
      ],
      { session: session || undefined },
    );

    // Tenant becomes ACTIVE before invoicing so credit & deposit bookkeeping land on it.
    tenant.status = 'ACTIVE';
    tenant.joiningDate = checkInDate;
    tenant.checkedOutAt = null;
    tenant.noticeGivenAt = null;
    tenant.expectedCheckoutDate = null;
    tenant.monthlyRent = monthlyRent;
    tenant.depositAmount = depositAmount;
    tenant.depositCollected = 0;
    tenant.depositAdjusted = 0;
    tenant.depositRefunded = 0;
    tenant.noticePeriodDays = noticePeriodDays;
    tenant.messOptIn = Boolean(messOptIn);
    tenant.current = {
      propertyId: bed.propertyId,
      buildingId: bed.buildingId,
      floorId: bed.floorId,
      roomId: bed.roomId,
      bedId: bed._id,
      allocationId: allocation._id,
      agreementId: agreement._id,
      rentId: rent._id,
    };

    const invoiceIds = [];
    if (depositAmount > 0) {
      const inv = await createInvoice(
        {
          org,
          tenant,
          kind: 'DEPOSIT',
          lines: [{ type: 'SECURITY_DEPOSIT', description: 'Refundable security deposit', amount: depositAmount }],
          issueDate: checkInDate,
          dueDate: checkInDate,
          propertyId: bed.propertyId,
          createdBy: req.user._id,
        },
        session,
      );
      invoiceIds.push(inv._id);
    }
    const firstInvoice = await createInvoice(
      {
        org,
        tenant,
        kind: 'RENT',
        lines: billing.buildRentLines(rent, first),
        issueDate: checkInDate,
        dueDate: D.addDays(checkInDate, dueDays),
        period: first,
        rentId: rent._id,
        propertyId: bed.propertyId,
        createdBy: req.user._id,
      },
      session,
    );
    invoiceIds.push(firstInvoice._id);

    // Optional collection at the desk (cash / UPI …) in the same transaction.
    let collected = null;
    if (dto.collect && dto.collect.amount > 0) {
      const payment = new Payment({
        organizationId,
        receiptNumber: await nextNumber(organizationId, 'RCPT', (settings.receiptPrefix || 'RCPT'), session),
        tenantId: tenant._id,
        propertyId: bed.propertyId,
        amount: dto.collect.amount,
        method: dto.collect.method,
        status: 'SUCCEEDED',
        reference: dto.collect.reference || '',
        paidAt: new Date(),
        source: 'STAFF',
        recordedBy: req.user._id,
      });
      await allocatePayment(
        { organizationId, payment, tenant, preferredInvoiceIds: invoiceIds, today: orgToday(org) },
        session,
      );
      await payment.save({ session: session || undefined });
      collected = payment.toJSON();
    }

    // App access for the resident (OTP login with their phone number).
    const user = await findOrCreateUserByPhone({ phone: tenant.phone, fullName: tenant.fullName, email: tenant.email }, session);
    tenant.userId = user._id;
    await tenant.save({ session: session || undefined });
    await ensureMembership(
      {
        organizationId,
        userId: user._id,
        role: 'TENANT',
        tenantId: tenant._id,
        displayName: tenant.fullName,
        phone: tenant.phone,
        email: tenant.email,
      },
      session,
    );

    const [checkInDoc] = await CheckIn.create(
      [
        {
          organizationId,
          checkInNumber: await nextNumber(organizationId, 'CHKIN', 'CHKIN', session),
          tenantId: tenant._id,
          propertyId: bed.propertyId,
          roomId: bed.roomId,
          bedId: bed._id,
          allocationId: allocation._id,
          agreementId: agreement._id,
          rentId: rent._id,
          checkInDate,
          monthlyRent,
          depositAmount,
          invoiceIds,
          kycStatusAtCheckIn: tenant.kycStatus,
          performedBy: req.user._id,
          notes: dto.notes || '',
        },
      ],
      { session: session || undefined },
    );
    await BedAllocation.updateOne(
      { _id: allocation._id, organizationId },
      { $set: { checkInId: checkInDoc._id } },
      { session: session || undefined },
    );

    return {
      checkIn: checkInDoc.toJSON(),
      tenant: tenant.toJSON(),
      bed: { id: bed._id, label: bed.label },
      agreementId: agreement._id,
      invoiceIds,
      collected,
      userId: String(user._id),
    };
  });

  audit(req, {
    action: 'checkin.create',
    entityType: 'CheckIn',
    entityId: result.checkIn.id,
    summary: `${result.tenant.fullName} checked in to ${room.roomNumber}-${result.bed.label}`,
  });
  notify({
    userIds: [result.userId],
    organizationId,
    type: 'checkin',
    title: `Welcome to ${property.name}!`,
    body: `Room ${room.roomNumber}${floor ? ` (${floor.name})` : ''}, bed ${result.bed.label}. Monthly rent ${formatINR(monthlyRent)}.`,
    data: { route: 'stay' },
    channels: ['inapp', 'push', 'sms'],
  });
  return result;
};

module.exports = { checkIn, DEFAULT_TERMS };
