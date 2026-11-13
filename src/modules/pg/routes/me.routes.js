const { createRouter } = require('../../core/router');
const { z, text, requiredText, email, phone, id, idParams, listQuery, dayKey } = require('../../core/validation');
const Tenant = require('../models/Tenant');
const PgProperty = require('../models/PgProperty');
const Room = require('../models/Room');
const Floor = require('../models/Floor');
const Bed = require('../models/Bed');
const Rent = require('../models/Rent');
const RentInvoice = require('../models/RentInvoice');
const Payment = require('../models/Payment');
const Complaint = require('../models/Complaint');
const Visitor = require('../models/Visitor');
const Notice = require('../models/Notice');
const TenantDocument = require('../models/TenantDocument');
const TenantAgreement = require('../models/TenantAgreement');
const MessMenu = require('../models/MessMenu');
const MealAttendance = require('../models/MealAttendance');
const Amenity = require('../models/Amenity');
const { MEALS } = require('../models/MealAttendance');
const { CATEGORIES, PRIORITIES } = require('../models/Complaint');
const paymentsSvc = require('../services/payments');
const { OPEN_STATUSES, orgToday } = require('../services/invoices');
const { depositHeldOf } = require('../services/checkout');
const { createComplaint, withImageUrls, imageUpload } = require('./ops.routes');
const { createVisitor, VisitorDto, notifySecurity } = require('./visitors.routes');
const { saveDocument, safe } = require('./documents.routes');
const { sendReceipt } = require('./money.routes');
const { uploadSingle, signedUrl } = require('../../storage');
const { COMPLAINT_FLOW, transition } = require('../services/workflow');
const { memberUserIdsForProperty } = require('../../saas/services/members');
const { listOptions, paginate } = require('../../core/query');
const { publicDoc } = require('../../core/schema');
const { paymentLimiter, uploadLimiter } = require('../../core/rateLimits');
const { audit } = require('../../core/audit');
const { round2 } = require('../../core/money');
const D = require('../../core/dates');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');
const { validation } = require('../../core/errors');

// Everything here runs with auth: 'tenant' — the tenant id comes from the
// caller's TENANT membership, so a resident can only ever reach their own
// records (every query below filters by req.ctx.tenantId).
const r = createRouter({ prefix: '/pg/me', tag: 'Tenant app' });
const T = { auth: 'tenant' };

const me = async (req, extra = {}) => {
  const tenant = await Tenant.findOne({ organizationId: req.ctx.orgId, _id: req.ctx.tenantId, ...extra });
  if (!tenant) throw errors.notFound('Resident profile');
  return tenant;
};

const isResident = tenant => ['ACTIVE', 'NOTICE'].includes(tenant.status);

r.get('/stay', { ...T, summary: 'My room, bed, rent, deposit & agreement' }, async req => {
  const organizationId = req.ctx.orgId;
  const tenant = (await me(req)).toJSON();
  const cur = tenant.current || {};
  const [property, room, floor, bed, rent, agreement, open] = await Promise.all([
    cur.propertyId ? PgProperty.findOne({ organizationId, _id: cur.propertyId }).select('name address contact rules amenityIds messEnabled photos').lean() : null,
    cur.roomId ? Room.findOne({ organizationId, _id: cur.roomId }).select('roomNumber roomType capacity attributes amenityIds').lean() : null,
    cur.floorId ? Floor.findOne({ organizationId, _id: cur.floorId }).select('name level').lean() : null,
    cur.bedId ? Bed.findOne({ organizationId, _id: cur.bedId }).select('label').lean() : null,
    cur.rentId ? Rent.findOne({ organizationId, _id: cur.rentId }).lean() : null,
    cur.agreementId ? TenantAgreement.findOne({ organizationId, _id: cur.agreementId }).lean() : null,
    RentInvoice.find({ organizationId, tenantId: tenant.id, status: { $in: OPEN_STATUSES }, balance: { $gt: 0 } }).select('balance status dueDate').lean(),
  ]);
  const amenityIds = [...new Set([...((property && property.amenityIds) || []), ...((room && room.amenityIds) || [])])];
  const amenities = amenityIds.length ? await Amenity.find({ organizationId, _id: { $in: amenityIds } }).select('name icon').lean() : [];
  const roommates = cur.roomId
    ? await Tenant.find({ organizationId, 'current.roomId': cur.roomId, status: { $in: ['ACTIVE', 'NOTICE'] }, _id: { $ne: tenant.id } }).select('fullName').lean()
    : [];
  return {
    tenant: {
      id: tenant.id,
      fullName: tenant.fullName,
      phone: tenant.phone,
      email: tenant.email,
      status: tenant.status,
      kycStatus: tenant.kycStatus,
      joiningDate: tenant.joiningDate,
      noticeGivenAt: tenant.noticeGivenAt,
      expectedCheckoutDate: tenant.expectedCheckoutDate,
      noticePeriodDays: tenant.noticePeriodDays,
      foodPreference: tenant.foodPreference,
      messOptIn: tenant.messOptIn,
      emergencyContacts: tenant.emergencyContacts,
      address: tenant.address,
      occupation: tenant.occupation,
    },
    property: property ? { id: property._id, name: property.name, address: property.address, contact: property.contact, rules: property.rules, messEnabled: property.messEnabled, photo: property.photos && property.photos[0] ? property.photos[0].url : null } : null,
    room: room ? { id: room._id, roomNumber: room.roomNumber, roomType: room.roomType, capacity: room.capacity, attributes: room.attributes } : null,
    floor: floor ? { name: floor.name } : null,
    bed: bed ? { id: bed._id, label: bed.label } : null,
    roommates: roommates.map(x => ({ id: x._id, fullName: x.fullName })),
    amenities: amenities.map(publicDoc),
    rent: rent ? { monthlyRent: rent.monthlyRent, charges: rent.charges, discount: rent.discount, billingDay: rent.billingDay, dueDays: rent.dueDays, nextBillingDate: rent.nextBillingDate } : null,
    deposit: { agreed: tenant.depositAmount, held: depositHeldOf(tenant), refunded: tenant.depositRefunded },
    creditBalance: tenant.creditBalance,
    dues: {
      outstanding: round2(open.reduce((t, i) => t + i.balance, 0)),
      overdue: round2(open.filter(i => i.status === 'OVERDUE').reduce((t, i) => t + i.balance, 0)),
      nextDueDate: open.length ? open.map(i => i.dueDate).sort((a, b) => a - b)[0] : null,
    },
    agreement: agreement ? publicDoc(agreement) : null,
  };
});

// ---- Rent, invoices, payments ------------------------------------------------------

r.get('/invoices', { ...T, permission: 'self.read', query: listQuery({ open: z.enum(['true', 'false']).optional() }), summary: 'My invoices' }, async req => {
  const q = req.valid.query;
  const filter = { organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId, status: q.open === 'true' ? { $in: OPEN_STATUSES } : { $ne: 'CANCELLED' } };
  return paginate(RentInvoice, filter, listOptions(q, { sortable: ['issueDate', 'dueDate'], defaultSort: '-issueDate' }));
});

r.get('/invoices/:id', { ...T, permission: 'self.read', params: idParams, summary: 'My invoice' }, async req => {
  const inv = await RentInvoice.findOne({ organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId, _id: req.valid.params.id }).lean();
  if (!inv) throw errors.notFound('Invoice');
  const payments = await Payment.find({ organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId, 'allocations.invoiceId': inv._id }).select('receiptNumber method paidAt allocations status').lean();
  return {
    ...publicDoc(inv),
    payments: payments.map(p => ({ id: p._id, receiptNumber: p.receiptNumber, method: p.method, paidAt: p.paidAt, status: p.status, amount: round2(p.allocations.filter(a => a.invoiceId === inv._id).reduce((t, a) => t + a.amount, 0)) })),
  };
});

r.get('/payments', { ...T, permission: 'self.read', query: listQuery(), summary: 'My payments & receipts' }, async req =>
  paginate(
    Payment,
    { organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId, status: { $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'PENDING'] } },
    listOptions(req.valid.query, { sortable: ['paidAt', 'createdAt'], defaultSort: '-createdAt' }),
    { select: '-gateway.checkoutUrl -idempotencyKey' },
  ),
);

// Start an online payment. The amount is computed on the server from the
// tenant's open invoices; the client only chooses which invoices.
r.post(
  '/payments',
  { ...T, permission: 'self.pay', body: z.object({ invoiceIds: z.array(id).max(20).optional() }), middleware: [paymentLimiter], subscription: false, success: 201, summary: 'Pay rent online (returns a checkout URL)' },
  async req => {
    const tenant = await me(req);
    if (tenant.status === 'PROSPECT') throw errors.conflict('Payments open after check-in.', 'TENANT_STATE');
    return paymentsSvc.initiateOnlinePayment(req, req.valid.body);
  },
);

// Polled after checkout. Pending payments are verified server-to-server
// with the gateway — the app's own view of success is never trusted.
r.get('/payments/:id', { ...T, permission: 'self.read', params: idParams, summary: 'Payment status (gateway-verified)' }, async req => {
  const p = await Payment.findOne({ organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId, _id: req.valid.params.id }).select('_id').lean();
  if (!p) throw errors.notFound('Payment');
  const fresh = await paymentsSvc.reconcilePayment(req.ctx.orgId, p._id);
  const out = publicDoc(fresh);
  delete out.idempotencyKey;
  return out;
});

r.get('/payments/:id/receipt.html', { ...T, permission: 'self.read', params: idParams, raw: true, summary: 'My printable receipt' }, async (req, res) => {
  const p = await Payment.findOne({ organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId, _id: req.valid.params.id }).lean();
  if (!p) throw errors.notFound('Payment');
  await sendReceipt(res, req.ctx.orgId, p);
});

// ---- Complaints -------------------------------------------------------------------------

r.get('/complaints', { ...T, permission: 'self.complaint', query: listQuery({ open: z.enum(['true', 'false']).optional() }), summary: 'My complaints' }, async req => {
  const q = req.valid.query;
  const filter = { organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId };
  if (q.open === 'true') filter.status = { $in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] };
  return paginate(Complaint, filter, listOptions(q, { sortable: ['createdAt'], searchFields: ['title'] }), { select: '-history -images' });
});

r.post(
  '/complaints',
  {
    ...T,
    permission: 'self.complaint',
    body: z.object({ category: z.enum(CATEGORIES), title: requiredText(120), description: text(2000).optional(), priority: z.enum(PRIORITIES).default('MEDIUM') }),
    success: 201,
    summary: 'Raise a complaint',
  },
  async req => {
    const tenant = await me(req);
    if (!isResident(tenant)) throw errors.conflict('Complaints can be raised during your stay.', 'TENANT_STATE');
    return createComplaint(
      req,
      { ...req.valid.body, propertyId: tenant.current.propertyId, roomId: tenant.current.roomId, bedId: tenant.current.bedId, tenantId: tenant._id },
      'TENANT',
    );
  },
);

const myComplaint = async req => {
  const c0 = await Complaint.findOne({ organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId, _id: req.valid.params.id });
  if (!c0) throw errors.notFound('Complaint');
  return c0;
};

r.get('/complaints/:id', { ...T, permission: 'self.complaint', params: idParams, summary: 'My complaint with timeline' }, async req =>
  withImageUrls((await myComplaint(req)).toJSON()),
);

r.post(
  '/complaints/:id/images',
  {
    ...T,
    permission: 'self.complaint',
    params: idParams,
    middleware: [uploadLimiter, uploadSingle('file', { imagesOnly: true })],
    multipart: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
    success: 201,
    summary: 'Attach a photo to my complaint',
  },
  async req => {
    await myComplaint(req);
    return imageUpload(Complaint, 'Complaint')(req);
  },
);

r.post(
  '/complaints/:id/feedback',
  { ...T, permission: 'self.complaint', params: idParams, body: z.object({ rating: z.coerce.number().int().min(1).max(5), feedback: text(1000).optional(), close: z.boolean().default(true) }), summary: 'Rate a resolved complaint' },
  async req => {
    const c0 = await myComplaint(req);
    if (!['RESOLVED', 'CLOSED'].includes(c0.status)) throw errors.conflict('You can rate a complaint once it is resolved.', 'INVALID_TRANSITION');
    c0.rating = req.valid.body.rating;
    c0.feedback = req.valid.body.feedback || '';
    if (req.valid.body.close && c0.status === 'RESOLVED') {
      transition(c0, 'CLOSED', COMPLAINT_FLOW, { userId: req.user._id, userName: req.user.fullName, note: 'Confirmed by resident' });
    }
    await c0.save();
    return withImageUrls(c0.toJSON());
  },
);

r.post('/complaints/:id/reopen', { ...T, permission: 'self.complaint', params: idParams, body: z.object({ reason: requiredText(500) }), summary: 'Re-open my complaint' }, async req => {
  const c0 = await myComplaint(req);
  if (!['RESOLVED', 'CLOSED'].includes(c0.status)) throw errors.conflict('Only resolved complaints can be re-opened.', 'INVALID_TRANSITION');
  const since = c0.resolvedAt || c0.closedAt || c0.updatedAt;
  if (since && Date.now() - new Date(since).getTime() > 7 * 24 * 3600 * 1000) {
    throw errors.conflict('Complaints can be re-opened within 7 days. Please raise a new one.', 'REOPEN_WINDOW_PASSED');
  }
  transition(c0, 'OPEN', COMPLAINT_FLOW, { userId: req.user._id, userName: req.user.fullName, note: req.valid.body.reason });
  await c0.save();
  memberUserIdsForProperty(req.ctx.orgId, ['OWNER', 'PROPERTY_MANAGER'], c0.propertyId)
    .then(userIds => notify({ userIds, organizationId: req.ctx.orgId, type: 'complaint_update', title: 'Complaint re-opened', body: `${c0.complaintNumber}: ${req.valid.body.reason}`, data: { route: 'complaint', id: c0._id } }))
    .catch(() => {});
  return withImageUrls(c0.toJSON());
});

// ---- Visitors --------------------------------------------------------------------------

r.get('/visitors', { ...T, permission: 'self.visitor', query: listQuery(), summary: 'My visitor passes' }, async req =>
  paginate(Visitor, { organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId }, listOptions(req.valid.query, { sortable: ['expectedAt', 'createdAt'], defaultSort: '-expectedAt' })),
);

r.post('/visitors', { ...T, permission: 'self.visitor', body: VisitorDto.omit({ tenantId: true }), success: 201, summary: 'Request a visitor pass' }, async req => {
  const { visitor } = await createVisitor(req, { ...req.valid.body, tenantId: req.ctx.tenantId }, { status: 'REQUESTED', requestedByRole: 'TENANT' });
  audit(req, { action: 'visitor.request', entityType: 'Visitor', entityId: visitor.id, summary: visitor.visitorName });
  notifySecurity(req.ctx.orgId, visitor);
  return visitor;
});

r.post('/visitors/:id/cancel', { ...T, permission: 'self.visitor', params: idParams, summary: 'Cancel my visitor pass' }, async req => {
  const updated = await Visitor.findOneAndUpdate(
    { organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId, _id: req.valid.params.id, status: { $in: ['REQUESTED', 'APPROVED'] } },
    { $set: { status: 'CANCELLED' } },
    { new: true },
  ).lean();
  if (!updated) throw errors.conflict('This pass can no longer be cancelled.', 'INVALID_TRANSITION');
  return publicDoc(updated);
});

// ---- Notices ----------------------------------------------------------------------------

r.get('/notices', { ...T, permission: 'notice.read', query: listQuery(), summary: 'Notices addressed to me' }, async req => {
  const filter = {
    organizationId: req.ctx.orgId,
    recipientTenantIds: req.ctx.tenantId,
    $or: [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }],
  };
  return paginate(Notice, filter, listOptions(req.valid.query, { sortable: ['publishedAt'], defaultSort: '-publishedAt' }), {
    select: '-recipientTenantIds -audience',
  });
});

// ---- Documents -----------------------------------------------------------------------------

r.get('/documents', { ...T, permission: 'self.document', summary: 'My documents' }, async req => {
  const docs = await TenantDocument.find({ organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId }).sort({ createdAt: -1 }).lean();
  return docs.map(d => safe(d));
});

r.post(
  '/documents',
  {
    ...T,
    permission: 'self.document',
    middleware: [uploadLimiter, uploadSingle('file')],
    success: 201,
    multipart: { type: 'object', required: ['file', 'type'], properties: { file: { type: 'string', format: 'binary' }, type: { type: 'string' }, subType: { type: 'string' }, docNumber: { type: 'string' } } },
    summary: 'Upload my KYC document',
  },
  async req => {
    const parsed = z
      .object({
        type: z.enum(['ID_PROOF', 'ADDRESS_PROOF', 'PHOTO', 'OTHER']),
        subType: z.enum(['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'OTHER']).optional(),
        docNumber: z.string().trim().max(40).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw validation(parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })));
    return saveDocument(req, { ...parsed.data, tenantId: req.ctx.tenantId }, 'TENANT');
  },
);

r.get('/documents/:id/url', { ...T, permission: 'self.document', params: idParams, summary: 'Signed URL for my document' }, async req => {
  const doc = await TenantDocument.findOne({ organizationId: req.ctx.orgId, tenantId: req.ctx.tenantId, _id: req.valid.params.id }).lean();
  if (!doc) throw errors.notFound('Document');
  return signedUrl(doc.fileKey, doc.storageDriver, { filename: doc.fileName, mimeType: doc.mimeType });
});

// ---- Profile, notice, agreement ---------------------------------------------------------------

r.put(
  '/profile',
  {
    ...T,
    permission: 'self.read',
    body: z.object({
      email: email.optional().or(z.literal('')),
      occupation: text(80).optional(),
      organizationName: text(120).optional(),
      foodPreference: z.enum(['VEG', 'NON_VEG', 'EGGETARIAN', 'VEGAN', 'JAIN']).optional(),
      address: z.object({ line1: text(200).optional(), city: text(60).optional(), state: text(60).optional(), pincode: z.string().trim().regex(/^\d{6}$/).optional().or(z.literal('')) }).optional(),
      emergencyContacts: z.array(z.object({ name: requiredText(80), relation: text(40).optional(), phone })).max(3).optional(),
    }),
    summary: 'Update my profile',
  },
  async req => {
    const tenant = await me(req);
    tenant.set(req.valid.body);
    await tenant.save();
    audit(req, { action: 'tenant.self_update', entityType: 'Tenant', entityId: tenant._id, changes: req.valid.body });
    return tenant.toJSON();
  },
);

r.post('/notice', { ...T, permission: 'self.read', body: z.object({ expectedCheckoutDate: dayKey.optional(), reason: text(300).optional() }), summary: 'Give notice to vacate' }, async req => {
  const tenant = await me(req);
  if (tenant.status !== 'ACTIVE') throw errors.conflict('Notice can only be given during an active stay.', 'TENANT_STATE');
  const today = orgToday(req.ctx.org);
  const minEnd = D.addDays(today, tenant.noticePeriodDays || 0);
  tenant.status = 'NOTICE';
  tenant.noticeGivenAt = today;
  tenant.expectedCheckoutDate = req.valid.body.expectedCheckoutDate ? D.toDay(req.valid.body.expectedCheckoutDate) : minEnd;
  await tenant.save();
  audit(req, { action: 'tenant.notice', entityType: 'Tenant', entityId: tenant._id, summary: req.valid.body.reason || 'Given by resident' });
  memberUserIdsForProperty(req.ctx.orgId, ['OWNER', 'PROPERTY_MANAGER', 'RECEPTIONIST'], tenant.current.propertyId)
    .then(userIds => notify({ userIds, organizationId: req.ctx.orgId, type: 'checkout', title: 'Notice to vacate', body: `${tenant.fullName} plans to move out on ${D.dayKey(tenant.expectedCheckoutDate)}.`, data: { route: 'tenant', id: tenant._id } }))
    .catch(() => {});
  return {
    status: tenant.status,
    noticeGivenAt: D.dayKey(tenant.noticeGivenAt),
    expectedCheckoutDate: D.dayKey(tenant.expectedCheckoutDate),
    shortNotice: tenant.expectedCheckoutDate < minEnd,
  };
});

r.post('/agreement/accept', { ...T, permission: 'self.read', summary: 'Accept my rental agreement' }, async req => {
  const tenant = await me(req);
  if (!tenant.current || !tenant.current.agreementId) throw errors.notFound('Agreement');
  const updated = await TenantAgreement.findOneAndUpdate(
    { organizationId: req.ctx.orgId, _id: tenant.current.agreementId, tenantId: tenant._id, status: 'ACTIVE', acceptedAt: null },
    { $set: { acceptedAt: new Date(), acceptedByUserId: req.user._id, acceptedIp: req.ip || '' } },
    { new: true },
  ).lean();
  if (!updated) throw errors.conflict('This agreement is already accepted or no longer active.', 'AGREEMENT_STATE');
  audit(req, { action: 'agreement.accept', entityType: 'TenantAgreement', entityId: updated._id });
  return publicDoc(updated);
});

// ---- Mess ---------------------------------------------------------------------------------------

r.get('/mess', { ...T, permission: 'self.mess', query: z.object({ from: dayKey.optional() }), summary: 'Menu for the week & my meal plan' }, async req => {
  const tenant = await me(req);
  const propertyId = tenant.current && tenant.current.propertyId;
  if (!propertyId) return { messOptIn: false, days: [] };
  const today = orgToday(req.ctx.org);
  const start = req.valid.query.from ? D.toDay(req.valid.query.from) : today;
  const days = Array.from({ length: 7 }, (_, i) => D.addDays(start, i));
  const [menus, marks] = await Promise.all([
    MessMenu.find({ organizationId: req.ctx.orgId, propertyId }).lean(),
    MealAttendance.find({ organizationId: req.ctx.orgId, tenantId: tenant._id, dateKey: { $in: days.map(D.dayKey) } }).lean(),
  ]);
  const menuOf = new Map(menus.map(m0 => [m0.dayOfWeek, m0]));
  return {
    messOptIn: tenant.messOptIn,
    foodPreference: tenant.foodPreference,
    days: days.map(d => {
      const key = D.dayKey(d);
      const menu = menuOf.get(d.getUTCDay()) || {};
      return {
        date: key,
        dayOfWeek: d.getUTCDay(),
        meals: MEALS.map(meal => {
          const field = meal.toLowerCase();
          const mark = marks.find(x => x.dateKey === key && x.meal === meal);
          return { meal, items: (menu[field] && menu[field].items) || [], time: (menu[field] && menu[field].time) || '', status: mark ? mark.status : tenant.messOptIn ? 'EXPECTED' : 'NOT_ENROLLED' };
        }),
      };
    }),
  };
});

const OptOutDto = z.object({ date: dayKey, meal: z.enum(MEALS) });

const assertOptOutWindow = (req, date) => {
  const today = orgToday(req.ctx.org);
  if (D.toDay(date) < today) throw errors.conflict('You cannot change past meals.', 'MEAL_LOCKED');
};

r.post('/mess/opt-out', { ...T, permission: 'self.mess', body: OptOutDto, summary: 'Skip a meal (helps the kitchen plan)' }, async req => {
  const tenant = await me(req);
  if (!tenant.messOptIn || !isResident(tenant)) throw errors.conflict('You are not enrolled in the mess.', 'NOT_ENROLLED');
  assertOptOutWindow(req, req.valid.body.date);
  const existing = await MealAttendance.findOne({ organizationId: req.ctx.orgId, tenantId: tenant._id, dateKey: req.valid.body.date, meal: req.valid.body.meal }).lean();
  if (existing && existing.status === 'CONSUMED') throw errors.conflict('This meal was already served.', 'MEAL_LOCKED');
  await MealAttendance.updateOne(
    { organizationId: req.ctx.orgId, tenantId: tenant._id, dateKey: req.valid.body.date, meal: req.valid.body.meal },
    { $set: { status: 'OPTED_OUT', propertyId: tenant.current.propertyId, date: D.toDay(req.valid.body.date), markedBy: req.user._id, markedByRole: 'TENANT' } },
    { upsert: true },
  );
  return { ...req.valid.body, status: 'OPTED_OUT' };
});

r.delete('/mess/opt-out', { ...T, permission: 'self.mess', body: OptOutDto, summary: 'Undo a skipped meal' }, async req => {
  const tenant = await me(req);
  assertOptOutWindow(req, req.valid.body.date);
  await MealAttendance.deleteOne({ organizationId: req.ctx.orgId, tenantId: tenant._id, dateKey: req.valid.body.date, meal: req.valid.body.meal, status: 'OPTED_OUT' });
  return { ...req.valid.body, status: 'EXPECTED' };
});

module.exports = r.router;
