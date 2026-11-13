const { createRouter } = require('../../core/router');
const { z, text, requiredText, id, idParams, listQuery, dayKey, dateRange } = require('../../core/validation');
const RentInvoice = require('../models/RentInvoice');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const Tenant = require('../models/Tenant');
const PgProperty = require('../models/PgProperty');
const Organization = require('../../saas/models/Organization');
const { INVOICE_STATUSES, INVOICE_KINDS } = require('../models/RentInvoice');
const { METHODS, OFFLINE_METHODS, STATUSES: PAYMENT_STATUSES } = require('../models/Payment');
const invoicesSvc = require('../services/invoices');
const paymentsSvc = require('../services/payments');
const { receiptHtml } = require('../services/receipt');
const { LINE_TYPES } = require('../services/billing');
const { listOptions, paginate } = require('../../core/query');
const { loadOwned } = require('../../core/refs');
const { propertyScope } = require('../../core/context');
const { publicDoc } = require('../../core/schema');
const { withTransaction } = require('../../core/tx');
const { paymentLimiter } = require('../../core/rateLimits');
const { audit, diff } = require('../../core/audit');
const { round2 } = require('../../core/money');
const D = require('../../core/dates');
const errors = require('../../core/errors');

const dateFilter = (field, q) => {
  if (!q.from && !q.to) return {};
  const f = {};
  if (q.from) f.$gte = D.toDay(q.from);
  if (q.to) f.$lt = D.addDays(D.toDay(q.to), 1);
  return { [field]: f };
};

const withTenantNames = async (organizationId, items) => {
  const tenants = await Tenant.find({ organizationId, _id: { $in: [...new Set(items.map(i => i.tenantId))] } })
    .select('fullName phone')
    .lean();
  const of = new Map(tenants.map(t => [t._id, t]));
  return items.map(i => ({ ...i, tenantName: (of.get(i.tenantId) || {}).fullName || '', tenantPhone: (of.get(i.tenantId) || {}).phone || '' }));
};

// ==== Invoices ===============================================================

const inv = createRouter({ prefix: '/pg/invoices', tag: 'Invoices' });

inv.get(
  '/',
  {
    permission: 'invoice.read',
    query: listQuery({
      tenantId: id.optional(),
      propertyId: id.optional(),
      status: z.enum(INVOICE_STATUSES).optional(),
      open: z.enum(['true', 'false']).optional(),
      kind: z.enum(INVOICE_KINDS).optional(),
      periodKey: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      ...dateRange,
    }),
    summary: 'List invoices',
  },
  async req => {
    const q = req.valid.query;
    const filter = { organizationId: req.ctx.orgId, ...propertyScope(req, 'propertyId', q.propertyId), ...dateFilter('issueDate', q) };
    if (q.tenantId) filter.tenantId = q.tenantId;
    if (q.status) filter.status = q.status;
    else if (q.open === 'true') filter.status = { $in: invoicesSvc.OPEN_STATUSES };
    if (q.kind) filter.kind = q.kind;
    if (q.periodKey) filter.periodKey = q.periodKey;
    const page = await paginate(
      RentInvoice,
      filter,
      listOptions(q, { sortable: ['issueDate', 'dueDate', 'total', 'balance', 'createdAt'], defaultSort: '-issueDate', searchFields: ['invoiceNumber'] }),
    );
    page.items = await withTenantNames(req.ctx.orgId, page.items);
    const totals = await RentInvoice.aggregate([
      { $match: { ...filter } },
      { $group: { _id: null, total: { $sum: '$total' }, paid: { $sum: '$amountPaid' }, balance: { $sum: '$balance' } } },
    ]);
    page.totals = totals[0] ? { total: round2(totals[0].total), paid: round2(totals[0].paid), balance: round2(totals[0].balance) } : { total: 0, paid: 0, balance: 0 };
    return page;
  },
);

inv.get('/:id', { permission: 'invoice.read', params: idParams, summary: 'Invoice with payments' }, async req => {
  const invoice = await loadOwned(RentInvoice, req.valid.params.id, req, { entity: 'Invoice', lean: true });
  const payments = await Payment.find({ organizationId: req.ctx.orgId, 'allocations.invoiceId': invoice._id }).lean();
  const [withName] = await withTenantNames(req.ctx.orgId, [publicDoc(invoice)]);
  return {
    ...withName,
    payments: payments.map(p => ({
      id: p._id,
      receiptNumber: p.receiptNumber,
      method: p.method,
      paidAt: p.paidAt,
      status: p.status,
      amount: round2(p.allocations.filter(a => a.invoiceId === invoice._id).reduce((t, a) => t + a.amount, 0)),
    })),
  };
});

const LineDto = z.object({ type: z.enum(LINE_TYPES), description: text(200).optional(), amount: z.coerce.number().min(-10000000).max(10000000) });

const AdhocDto = z.object({
  tenantId: id,
  lines: z.array(LineDto.extend({ amount: z.coerce.number().gt(0).max(10000000) })).min(1).max(30),
  dueDate: dayKey.optional(),
  notes: text(1000).optional(),
});

// One-off bill (electricity reading, damages, extra services …).
inv.post('/', { permission: 'invoice.create', body: AdhocDto, success: 201, summary: 'Create a one-off invoice' }, async req => {
  const b = req.valid.body;
  const tenant0 = await loadOwned(Tenant, b.tenantId, req, { entity: 'Tenant', propertyField: 'current.propertyId', lean: true });
  if (!tenant0.current || !tenant0.current.propertyId) throw errors.conflict('This tenant has no stay to bill.', 'TENANT_NOT_CHECKED_IN');
  const today = invoicesSvc.orgToday(req.ctx.org);
  const invoice = await withTransaction(async session => {
    const tenant = await Tenant.findOne({ _id: tenant0._id, organizationId: req.ctx.orgId }).session(session);
    const created = await invoicesSvc.createInvoice(
      {
        org: req.ctx.org,
        tenant,
        kind: 'ADHOC',
        lines: b.lines.map(l => ({ ...l, description: l.description || '' })),
        issueDate: today,
        dueDate: b.dueDate ? D.toDay(b.dueDate) : D.addDays(today, (req.ctx.org.settings && req.ctx.org.settings.dueDays) || 5),
        propertyId: tenant.current.propertyId,
        notes: b.notes || '',
        createdBy: req.user._id,
      },
      session,
    );
    await tenant.save({ session: session || undefined });
    return created.toJSON();
  });
  audit(req, { action: 'invoice.create', entityType: 'RentInvoice', entityId: invoice.id, summary: `${invoice.invoiceNumber} ${invoice.total}` });
  return invoice;
});

inv.put(
  '/:id',
  {
    permission: 'invoice.update',
    params: idParams,
    body: z.object({ lines: z.array(LineDto).min(1).max(40).optional(), dueDate: dayKey.optional(), notes: text(1000).optional() }),
    summary: 'Edit invoice lines / due date',
  },
  async req => {
    const invoice = await loadOwned(RentInvoice, req.valid.params.id, req, { entity: 'Invoice' });
    if (['CANCELLED', 'PAID'].includes(invoice.status)) throw errors.conflict('Paid or cancelled invoices cannot be edited.', 'INVOICE_LOCKED');
    const before = invoice.toJSON();
    const b = req.valid.body;
    if (b.lines) invoice.lines = b.lines;
    if (b.dueDate) invoice.dueDate = D.toDay(b.dueDate);
    if (b.notes !== undefined) invoice.notes = b.notes;
    invoicesSvc.recalcInvoice(invoice, invoicesSvc.orgToday(req.ctx.org));
    if (invoice.total < invoice.amountPaid) {
      throw errors.conflict('The new total is lower than what has already been paid.', 'INVOICE_BELOW_PAID');
    }
    await invoice.save();
    audit(req, { action: 'invoice.update', entityType: 'RentInvoice', entityId: invoice._id, changes: diff(before, invoice.toJSON(), ['lines', 'total', 'dueDate', 'notes']) });
    return invoice.toJSON();
  },
);

inv.post('/:id/waive-late-fee', { permission: 'invoice.update', params: idParams, summary: 'Remove and stop the late fee' }, async req => {
  const invoice = await loadOwned(RentInvoice, req.valid.params.id, req, { entity: 'Invoice' });
  if (invoice.status === 'CANCELLED') throw errors.conflict('This invoice is cancelled.', 'INVOICE_LOCKED');
  const fee = invoice.lines.filter(l => l.type === 'LATE_FEE').reduce((t, l) => t + l.amount, 0);
  if (fee > 0 && round2(invoice.total - fee) < invoice.amountPaid) {
    throw errors.conflict('The late fee has already been paid — refund instead.', 'INVOICE_BELOW_PAID');
  }
  invoice.lines = invoice.lines.filter(l => l.type !== 'LATE_FEE');
  invoice.lateFeeWaived = true;
  invoicesSvc.recalcInvoice(invoice, invoicesSvc.orgToday(req.ctx.org));
  await invoice.save();
  audit(req, { action: 'invoice.waive_late_fee', entityType: 'RentInvoice', entityId: invoice._id, summary: `Waived ${fee}` });
  return invoice.toJSON();
});

inv.post('/:id/cancel', { permission: 'invoice.cancel', params: idParams, body: z.object({ reason: requiredText(300) }), summary: 'Cancel an unpaid invoice' }, async req => {
  const invoice = await loadOwned(RentInvoice, req.valid.params.id, req, { entity: 'Invoice' });
  if (invoice.status === 'CANCELLED') throw errors.conflict('Already cancelled.', 'INVOICE_LOCKED');
  if (invoice.amountPaid > 0) throw errors.conflict('Invoices with payments cannot be cancelled. Adjust the lines instead.', 'INVOICE_HAS_PAYMENTS');
  invoice.status = 'CANCELLED';
  invoice.cancelledAt = new Date();
  invoice.cancelledBy = req.user._id;
  invoice.cancelReason = req.valid.body.reason;
  invoice.periodLock = null; // lets the period be re-issued if needed
  invoice.balance = 0;
  await invoice.save();
  audit(req, { action: 'invoice.cancel', entityType: 'RentInvoice', entityId: invoice._id, summary: req.valid.body.reason });
  return invoice.toJSON();
});

inv.post('/generate', { permission: 'invoice.generate', summary: 'Generate due monthly invoices now (idempotent)' }, async req => {
  const created = await invoicesSvc.generateDueInvoices(req.ctx.orgId);
  const overdue = await invoicesSvc.refreshOverdue(req.ctx.orgId);
  audit(req, { action: 'invoice.generate', entityType: 'Organization', entityId: req.ctx.orgId, summary: `${created.created} created` });
  return { ...created, ...overdue };
});

// ==== Payments ===============================================================

const pay = createRouter({ prefix: '/pg/payments', tag: 'Payments' });

pay.get(
  '/',
  {
    permission: 'payment.read',
    query: listQuery({
      tenantId: id.optional(),
      propertyId: id.optional(),
      method: z.enum(METHODS).optional(),
      status: z.enum(PAYMENT_STATUSES).optional(),
      ...dateRange,
    }),
    summary: 'List payments',
  },
  async req => {
    const q = req.valid.query;
    const filter = { organizationId: req.ctx.orgId, ...propertyScope(req, 'propertyId', q.propertyId), ...dateFilter('paidAt', q) };
    if (q.tenantId) filter.tenantId = q.tenantId;
    if (q.method) filter.method = q.method;
    filter.status = q.status || { $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'PENDING'] };
    const page = await paginate(
      Payment,
      filter,
      listOptions(q, { sortable: ['paidAt', 'createdAt', 'amount'], defaultSort: '-createdAt', searchFields: ['receiptNumber', 'reference'] }),
      { select: '-gateway.checkoutUrl' },
    );
    page.items = await withTenantNames(req.ctx.orgId, page.items);
    return page;
  },
);

const RecordDto = z.object({
  tenantId: id,
  amount: z.coerce.number().gt(0, 'Amount must be greater than 0').max(10000000),
  method: z.enum(OFFLINE_METHODS),
  reference: text(120).optional(),
  paidAt: dayKey.optional(),
  invoiceIds: z.array(id).max(50).optional(),
  notes: text(500).optional(),
});

// Idempotency-Key header makes retries on flaky networks safe.
pay.post('/', { permission: 'payment.record', body: RecordDto, success: 201, summary: 'Record a cash / UPI / bank / card payment' }, async req => {
  const key = String(req.get('idempotency-key') || '').trim();
  if (key && !/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw errors.badRequest('Invalid Idempotency-Key header.', 'VALIDATION_ERROR');
  const { payment, duplicate } = await paymentsSvc.recordOfflinePayment(req, { ...req.valid.body, idempotencyKey: key || null });
  return { ...publicDoc(payment), duplicate };
});

pay.get('/:id', { permission: 'payment.read', params: idParams, summary: 'Payment detail' }, async req => {
  const p = await loadOwned(Payment, req.valid.params.id, req, { entity: 'Payment', lean: true });
  const [withName] = await withTenantNames(req.ctx.orgId, [publicDoc(p)]);
  return withName;
});

pay.post('/:id/reconcile', { permission: 'payment.read', params: idParams, write: false, summary: 'Re-check a pending online payment with the gateway' }, async req =>
  publicDoc(await paymentsSvc.reconcilePayment(req.ctx.orgId, req.valid.params.id)),
);

const receiptData = async (organizationId, payment) => {
  const [org, tenant, property, invoices] = await Promise.all([
    Organization.findById(organizationId).lean(),
    Tenant.findOne({ organizationId, _id: payment.tenantId }).select('fullName phone').lean(),
    payment.propertyId ? PgProperty.findOne({ organizationId, _id: payment.propertyId }).select('name').lean() : null,
    RentInvoice.find({ organizationId, _id: { $in: payment.allocations.map(a => a.invoiceId) } }).select('invoiceNumber kind periodKey').lean(),
  ]);
  return { org, tenant, property, payment, invoices };
};

const sendReceipt = async (res, organizationId, payment) => {
  if (!['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(payment.status)) {
    throw errors.conflict('A receipt is available once the payment succeeds.', 'PAYMENT_NOT_COMPLETE');
  }
  const html = receiptHtml(await receiptData(organizationId, payment));
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.setHeader('Cache-Control', 'private, no-store');
  res.type('html').send(html);
};

pay.get('/:id/receipt', { permission: 'payment.read', params: idParams, summary: 'Receipt data (JSON)' }, async req => {
  const p = await loadOwned(Payment, req.valid.params.id, req, { entity: 'Payment', lean: true });
  if (!['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status)) {
    throw errors.conflict('A receipt is available once the payment succeeds.', 'PAYMENT_NOT_COMPLETE');
  }
  const d = await receiptData(req.ctx.orgId, p);
  return {
    receiptNumber: p.receiptNumber,
    paidAt: p.paidAt,
    amount: p.amount,
    method: p.method,
    reference: p.reference || (p.gateway && p.gateway.paymentId) || '',
    organization: { name: d.org.name, gstin: d.org.gstin, address: d.org.address },
    property: d.property ? { name: d.property.name } : null,
    tenant: d.tenant ? { name: d.tenant.fullName, phone: d.tenant.phone } : null,
    allocations: p.allocations.map(a => {
      const i = d.invoices.find(x => x._id === a.invoiceId) || {};
      return { invoiceId: a.invoiceId, invoiceNumber: i.invoiceNumber, kind: i.kind, periodKey: i.periodKey, amount: a.amount };
    }),
    advance: p.unappliedAmount,
  };
});

pay.get('/:id/receipt.html', { permission: 'payment.read', params: idParams, raw: true, summary: 'Printable HTML receipt' }, async (req, res) => {
  const p = await loadOwned(Payment, req.valid.params.id, req, { entity: 'Payment', lean: true });
  await sendReceipt(res, req.ctx.orgId, p);
});

pay.post(
  '/:id/refund',
  {
    permission: 'payment.refund',
    params: idParams,
    body: z.object({
      amount: z.coerce.number().gt(0).max(10000000),
      reason: requiredText(300),
      method: z.enum(['CASH', 'UPI', 'BANK_TRANSFER']).optional(),
      reference: text(120).optional(),
    }),
    middleware: [paymentLimiter],
    summary: 'Refund the unallocated part of a payment',
  },
  req => paymentsSvc.refundPayment(req, req.valid.params.id, req.valid.body),
);

// ==== Refunds ================================================================

const ref = createRouter({ prefix: '/pg/refunds', tag: 'Payments' });

ref.get(
  '/',
  { permission: 'payment.read', query: listQuery({ tenantId: id.optional(), status: z.enum(['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'CANCELLED']).optional() }), summary: 'List refunds' },
  async req => {
    const q = req.valid.query;
    const filter = { organizationId: req.ctx.orgId };
    if (q.tenantId) filter.tenantId = q.tenantId;
    if (q.status) filter.status = q.status;
    const page = await paginate(Refund, filter, listOptions(q, { sortable: ['createdAt', 'amount'] }));
    page.items = await withTenantNames(req.ctx.orgId, page.items);
    return page;
  },
);

ref.post(
  '/:id/process',
  {
    permission: 'payment.refund',
    params: idParams,
    body: z.object({ method: z.enum(['CASH', 'UPI', 'BANK_TRANSFER']), reference: text(120).optional() }),
    summary: 'Mark a pending refund as paid out',
  },
  req => paymentsSvc.processRefund(req, req.valid.params.id, req.valid.body),
);

module.exports = {
  invoicesRouter: inv.router,
  paymentsRouter: pay.router,
  refundsRouter: ref.router,
  sendReceipt,
  receiptData,
};
