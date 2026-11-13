const { createRouter } = require('../../core/router');
const { z, text, requiredText, phone, email, id, idParams, listQuery, dayKey } = require('../../core/validation');
const Tenant = require('../models/Tenant');
const Bed = require('../models/Bed');
const Room = require('../models/Room');
const Floor = require('../models/Floor');
const PgProperty = require('../models/PgProperty');
const Rent = require('../models/Rent');
const RentInvoice = require('../models/RentInvoice');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const TenantDocument = require('../models/TenantDocument');
const TenantAgreement = require('../models/TenantAgreement');
const { TENANT_STATUSES } = require('../models/Tenant');
const { claimBed, openAllocation, closeAllocation } = require('../services/allocation');
const { depositHeldOf } = require('../services/checkout');
const { OPEN_STATUSES, orgToday } = require('../services/invoices');
const { assertLimit } = require('../../saas/services/entitlements');
const { listOptions, paginate } = require('../../core/query');
const { loadOwned } = require('../../core/refs');
const { publicDoc } = require('../../core/schema');
const { propertyScope, assertPropertyAccess } = require('../../core/context');
const { withTransaction } = require('../../core/tx');
const { audit, diff } = require('../../core/audit');
const { round2 } = require('../../core/money');
const { track } = require('../../analytics/track');
const D = require('../../core/dates');
const errors = require('../../core/errors');

const r = createRouter({ prefix: '/pg/tenants', tag: 'Tenants' });

const EmergencyContactDto = z.object({ name: requiredText(80), relation: text(40).optional(), phone });
const AddressDto = z.object({
  line1: text(200).optional(),
  city: text(60).optional(),
  state: text(60).optional(),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Invalid pincode').optional().or(z.literal('')),
});

const profile = {
  fullName: requiredText(100),
  phone,
  email: email.optional().or(z.literal('')),
  dob: dayKey.optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  address: AddressDto.optional(),
  occupation: text(80).optional(),
  organizationName: text(120).optional(),
  emergencyContacts: z.array(EmergencyContactDto).max(3).optional(),
  foodPreference: z.enum(['VEG', 'NON_VEG', 'EGGETARIAN', 'VEGAN', 'JAIN']).optional(),
  messOptIn: z.boolean().optional(),
  source: z.enum(['WALK_IN', 'REFERRAL', 'ONLINE', 'BROKER', 'OTHER']).optional(),
  noticePeriodDays: z.coerce.number().int().min(0).max(180).optional(),
  notes: text(2000).optional(),
};

const CreateDto = z.object(profile);
const UpdateDto = z.object(profile).partial();
const ListDto = listQuery({
  status: z.enum(TENANT_STATUSES).optional(),
  propertyId: id.optional(),
  roomId: id.optional(),
  kycStatus: z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional(),
  current: z.enum(['true', 'false']).optional(),
});

const toData = body => ({ ...body, ...(body.dob ? { dob: D.toDay(body.dob) } : {}) });

const onDuplicatePhone = e => {
  if (e && e.code === 11000) {
    throw errors.conflict('A current tenant with this phone number already exists.', 'DUPLICATE_TENANT', { field: 'phone' });
  }
  throw e;
};

/** Room / bed labels for list rows. */
const decorate = async (req, items) => {
  const organizationId = req.ctx.orgId;
  const bedIds = items.map(t => t.current && t.current.bedId).filter(Boolean);
  if (!bedIds.length) return items;
  const beds = await Bed.find({ organizationId, _id: { $in: bedIds } }).select('label roomId').lean();
  const rooms = await Room.find({ organizationId, _id: { $in: beds.map(b => b.roomId) } }).select('roomNumber').lean();
  const bedOf = new Map(beds.map(b => [b._id, b]));
  const roomOf = new Map(rooms.map(x => [x._id, x]));
  return items.map(t => {
    const bed = t.current && bedOf.get(t.current.bedId);
    const room = bed && roomOf.get(bed.roomId);
    return { ...t, roomNumber: room ? room.roomNumber : null, bedLabel: bed ? bed.label : null };
  });
};

r.get('/', { permission: 'tenant.read', query: ListDto, summary: 'List / search tenants' }, async req => {
  const q = req.valid.query;
  const filter = { organizationId: req.ctx.orgId, ...propertyScope(req, 'current.propertyId', q.propertyId) };
  if (q.status) filter.status = q.status;
  else if (q.current === 'true') filter.status = { $in: ['PROSPECT', 'ACTIVE', 'NOTICE'] };
  if (q.roomId) filter['current.roomId'] = q.roomId;
  if (q.kycStatus) filter.kycStatus = q.kycStatus;
  const page = await paginate(
    Tenant,
    filter,
    listOptions(q, { sortable: ['fullName', 'createdAt', 'joiningDate', 'monthlyRent'], defaultSort: 'fullName', searchFields: ['fullName', 'phone', 'email'] }),
  );
  page.items = await decorate(req, page.items);
  return page;
});

r.post('/', { permission: 'tenant.create', body: CreateDto, success: 201, summary: 'Add a tenant / prospect' }, async req => {
  const organizationId = req.ctx.orgId;
  await assertLimit(organizationId, 'maxTenants', 1);
  const data = toData(req.valid.body);
  const tenant = await Tenant.create({
    ...data,
    organizationId,
    status: 'PROSPECT',
    noticePeriodDays: data.noticePeriodDays ?? (req.ctx.org.settings && req.ctx.org.settings.noticePeriodDays) ?? 30,
  }).catch(onDuplicatePhone);
  audit(req, { action: 'tenant.create', entityType: 'Tenant', entityId: tenant._id, summary: `${tenant.fullName} added` });
  track('tenant_created', { userId: req.user._id, organizationId, props: { source: tenant.source } });
  return tenant.toJSON();
});

r.get('/:id', { permission: 'tenant.read', params: idParams, summary: 'Tenant profile, stay & dues' }, async req => {
  const organizationId = req.ctx.orgId;
  const tenant = await loadOwned(Tenant, req.valid.params.id, req, { entity: 'Tenant', propertyField: 'current.propertyId', lean: true });
  const cur = tenant.current || {};
  const [property, room, floor, bed, rent, agreement, open, documents] = await Promise.all([
    cur.propertyId ? PgProperty.findOne({ organizationId, _id: cur.propertyId }).select('name address').lean() : null,
    cur.roomId ? Room.findOne({ organizationId, _id: cur.roomId }).select('roomNumber roomType').lean() : null,
    cur.floorId ? Floor.findOne({ organizationId, _id: cur.floorId }).select('name').lean() : null,
    cur.bedId ? Bed.findOne({ organizationId, _id: cur.bedId }).select('label').lean() : null,
    cur.rentId ? Rent.findOne({ organizationId, _id: cur.rentId }).lean() : null,
    cur.agreementId ? TenantAgreement.findOne({ organizationId, _id: cur.agreementId }).lean() : null,
    RentInvoice.find({ organizationId, tenantId: tenant._id, status: { $in: OPEN_STATUSES }, balance: { $gt: 0 } }).select('balance status kind').lean(),
    TenantDocument.find({ organizationId, tenantId: tenant._id }).select('type status').lean(),
  ]);
  return {
    ...publicDoc(tenant),
    stay: {
      property: property ? { id: property._id, name: property.name, city: property.address && property.address.city } : null,
      room: room ? { id: room._id, roomNumber: room.roomNumber, roomType: room.roomType } : null,
      floor: floor ? { id: floor._id, name: floor.name } : null,
      bed: bed ? { id: bed._id, label: bed.label } : null,
      rent: rent ? publicDoc(rent) : null,
      agreement: agreement ? publicDoc(agreement) : null,
    },
    dues: {
      outstanding: round2(open.reduce((t, i) => t + i.balance, 0)),
      overdue: round2(open.filter(i => i.status === 'OVERDUE').reduce((t, i) => t + i.balance, 0)),
      openInvoices: open.length,
    },
    depositHeld: depositHeldOf(tenant),
    documents: {
      total: documents.length,
      verified: documents.filter(d => d.status === 'VERIFIED').length,
      pending: documents.filter(d => d.status === 'PENDING').length,
    },
  };
});

r.put('/:id', { permission: 'tenant.update', params: idParams, body: UpdateDto, summary: 'Update tenant profile' }, async req => {
  const tenant = await loadOwned(Tenant, req.valid.params.id, req, { entity: 'Tenant', propertyField: 'current.propertyId' });
  const before = tenant.toJSON();
  const data = toData(req.valid.body);
  tenant.set(data);
  await tenant.save().catch(onDuplicatePhone);
  audit(req, { action: 'tenant.update', entityType: 'Tenant', entityId: tenant._id, changes: diff(before, tenant.toJSON(), Object.keys(data)) });
  return tenant.toJSON();
});

r.delete('/:id', { permission: 'tenant.delete', params: idParams, summary: 'Delete a prospect / former tenant' }, async req => {
  const tenant = await loadOwned(Tenant, req.valid.params.id, req, { entity: 'Tenant', propertyField: 'current.propertyId' });
  if (['ACTIVE', 'NOTICE'].includes(tenant.status)) {
    throw errors.conflict('Check this tenant out before deleting.', 'TENANT_CHECKED_IN');
  }
  await tenant.softDelete(req.user._id);
  audit(req, { action: 'tenant.delete', entityType: 'Tenant', entityId: tenant._id, summary: `${tenant.fullName} deleted` });
  return { id: tenant._id, deleted: true };
});

// ---- Notice period ------------------------------------------------------------

const NoticeDto = z.object({ noticeDate: dayKey.optional(), expectedCheckoutDate: dayKey.optional(), note: text(300).optional() });

r.post('/:id/notice', { permission: 'tenant.update', params: idParams, body: NoticeDto, summary: 'Record notice to vacate' }, async req => {
  const tenant = await loadOwned(Tenant, req.valid.params.id, req, { entity: 'Tenant', propertyField: 'current.propertyId' });
  if (tenant.status !== 'ACTIVE') throw errors.conflict('Only active tenants can give notice.', 'TENANT_STATE');
  const noticeDate = req.valid.body.noticeDate ? D.toDay(req.valid.body.noticeDate) : orgToday(req.ctx.org);
  tenant.status = 'NOTICE';
  tenant.noticeGivenAt = noticeDate;
  tenant.expectedCheckoutDate = req.valid.body.expectedCheckoutDate
    ? D.toDay(req.valid.body.expectedCheckoutDate)
    : D.addDays(noticeDate, tenant.noticePeriodDays || 0);
  await tenant.save();
  audit(req, { action: 'tenant.notice', entityType: 'Tenant', entityId: tenant._id, summary: `Notice until ${D.dayKey(tenant.expectedCheckoutDate)}` });
  return tenant.toJSON();
});

r.delete('/:id/notice', { permission: 'tenant.update', params: idParams, summary: 'Withdraw notice' }, async req => {
  const tenant = await loadOwned(Tenant, req.valid.params.id, req, { entity: 'Tenant', propertyField: 'current.propertyId' });
  if (tenant.status !== 'NOTICE') throw errors.conflict('This tenant is not on notice.', 'TENANT_STATE');
  tenant.status = 'ACTIVE';
  tenant.noticeGivenAt = null;
  tenant.expectedCheckoutDate = null;
  await tenant.save();
  audit(req, { action: 'tenant.notice.withdraw', entityType: 'Tenant', entityId: tenant._id });
  return tenant.toJSON();
});

// ---- Bed transfer (room change) --------------------------------------------------

const TransferDto = z.object({
  bedId: id,
  effectiveDate: dayKey.optional(),
  monthlyRent: z.coerce.number().min(0).max(1000000).optional(),
  note: text(300).optional(),
});

r.post('/:id/transfer', { permission: 'tenant.update', params: idParams, body: TransferDto, summary: 'Move a tenant to another bed' }, async req => {
  const organizationId = req.ctx.orgId;
  const body = req.valid.body;
  const tenant0 = await loadOwned(Tenant, req.valid.params.id, req, { entity: 'Tenant', propertyField: 'current.propertyId', lean: true });
  if (!['ACTIVE', 'NOTICE'].includes(tenant0.status) || !tenant0.current || !tenant0.current.allocationId) {
    throw errors.conflict('Only checked-in tenants can be transferred.', 'TENANT_NOT_CHECKED_IN');
  }
  if (tenant0.current.bedId === body.bedId) throw errors.badRequest('The tenant is already in this bed.', 'SAME_BED');
  const target = await Bed.findOne({ organizationId, _id: body.bedId }).lean();
  if (!target) throw errors.notFound('Bed');
  assertPropertyAccess(req, target.propertyId);
  const room = await Room.findOne({ organizationId, _id: target.roomId }).lean();
  if (!room || room.status !== 'ACTIVE') throw errors.conflict('The target room is not available.', 'ROOM_UNAVAILABLE');
  const effective = body.effectiveDate ? D.toDay(body.effectiveDate) : orgToday(req.ctx.org);
  const monthlyRent = body.monthlyRent ?? target.rent ?? room.rentPerBed;

  const result = await withTransaction(async session => {
    const tenant = await Tenant.findOne({ _id: tenant0._id, organizationId }).session(session);
    const oldAllocation = await closeAllocation(
      { organizationId, allocationId: tenant.current.allocationId, tenantId: tenant._id, endDate: effective, reason: 'TRANSFER' },
      session,
    );
    const bed = await claimBed(organizationId, target._id, tenant._id, session);
    const allocation = await openAllocation({ organizationId, bed, tenantId: tenant._id, startDate: effective, monthlyRent }, session);
    if (tenant.current.rentId) {
      await Rent.updateOne(
        { _id: tenant.current.rentId, organizationId },
        { $set: { monthlyRent, bedId: bed._id, propertyId: bed.propertyId, allocationId: allocation._id } },
        { session: session || undefined },
      );
    }
    if (tenant.current.agreementId) {
      await TenantAgreement.updateOne(
        { _id: tenant.current.agreementId, organizationId },
        { $set: { bedId: bed._id, propertyId: bed.propertyId, allocationId: allocation._id, monthlyRent } },
        { session: session || undefined },
      );
    }
    tenant.monthlyRent = monthlyRent;
    tenant.current = {
      ...tenant.current.toObject(),
      propertyId: bed.propertyId,
      buildingId: bed.buildingId,
      floorId: bed.floorId,
      roomId: bed.roomId,
      bedId: bed._id,
      allocationId: allocation._id,
    };
    await tenant.save({ session: session || undefined });
    return { tenant: tenant.toJSON(), fromBedId: oldAllocation.bedId, toBedId: bed._id };
  });
  audit(req, {
    action: 'tenant.transfer',
    entityType: 'Tenant',
    entityId: tenant0._id,
    changes: { bedId: { from: result.fromBedId, to: result.toBedId }, monthlyRent: { from: tenant0.monthlyRent, to: monthlyRent } },
    summary: body.note || '',
  });
  return result.tenant;
});

// ---- Ledger ------------------------------------------------------------------------

r.get('/:id/ledger', { permission: 'invoice.read', params: idParams, summary: 'Invoices, payments & refunds with running balance' }, async req => {
  const organizationId = req.ctx.orgId;
  const tenant = await loadOwned(Tenant, req.valid.params.id, req, { entity: 'Tenant', propertyField: 'current.propertyId', lean: true });
  const [invoices, payments, refunds] = await Promise.all([
    RentInvoice.find({ organizationId, tenantId: tenant._id }).sort({ issueDate: 1 }).lean(),
    Payment.find({ organizationId, tenantId: tenant._id, status: { $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }).sort({ paidAt: 1 }).lean(),
    Refund.find({ organizationId, tenantId: tenant._id }).sort({ createdAt: 1 }).lean(),
  ]);
  const entries = [
    ...invoices
      .filter(i => i.status !== 'CANCELLED')
      .map(i => ({ at: i.issueDate, type: 'INVOICE', id: i._id, ref: i.invoiceNumber, description: `${i.kind} invoice`, debit: i.total, credit: 0, status: i.status })),
    ...payments.map(p => ({ at: p.paidAt, type: 'PAYMENT', id: p._id, ref: p.receiptNumber, description: p.method.replace('_', ' '), debit: 0, credit: p.amount, status: p.status })),
    ...refunds
      .filter(x => x.status !== 'CANCELLED')
      .map(x => ({ at: x.createdAt, type: 'REFUND', id: x._id, ref: x.refundNumber, description: x.type.replace('_', ' '), debit: x.amount, credit: 0, status: x.status })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  let balance = 0;
  for (const e of entries) {
    balance = round2(balance + e.debit - e.credit);
    e.balance = balance;
  }
  return {
    tenant: { id: tenant._id, fullName: tenant.fullName },
    entries,
    summary: {
      outstanding: round2(invoices.filter(i => OPEN_STATUSES.includes(i.status)).reduce((t, i) => t + i.balance, 0)),
      creditBalance: tenant.creditBalance || 0,
      depositHeld: depositHeldOf(tenant),
    },
  };
});

module.exports = r.router;
