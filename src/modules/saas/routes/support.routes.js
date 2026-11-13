const { createRouter } = require('../../core/router');
const { z, text, requiredText, idParams, listQuery } = require('../../core/validation');
const SupportTicket = require('../models/SupportTicket');
const { listOptions, paginate } = require('../../core/query');
const { nextNumber } = require('../../core/counters');
const { audit } = require('../../core/audit');
const errors = require('../../core/errors');

// Organization → platform support.
const r = createRouter({ prefix: '/pg/support/tickets', tag: 'Support' });

const STATUS = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'];

r.get('/', { permission: 'support.manage', query: listQuery({ status: z.enum(STATUS).optional() }), summary: 'My support tickets' }, async req => {
  const q = req.valid.query;
  return paginate(
    SupportTicket,
    { organizationId: req.ctx.orgId, ...(q.status ? { status: q.status } : {}) },
    listOptions(q, { sortable: ['lastActivityAt', 'createdAt'], defaultSort: '-lastActivityAt', searchFields: ['subject', 'ticketNumber'] }),
    { select: '-messages' },
  );
});

const CreateDto = z.object({
  subject: requiredText(160),
  category: z.enum(['BILLING', 'TECHNICAL', 'ACCOUNT', 'FEATURE_REQUEST', 'OTHER']).default('OTHER'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  message: requiredText(5000),
});

r.post('/', { permission: 'support.manage', body: CreateDto, success: 201, subscription: false, summary: 'Raise a support ticket' }, async req => {
  const b = req.valid.body;
  const ticket = await SupportTicket.create({
    organizationId: req.ctx.orgId,
    ticketNumber: await nextNumber(req.ctx.orgId, 'TKT', 'TKT'),
    subject: b.subject,
    category: b.category,
    priority: b.priority,
    createdByUserId: req.user._id,
    messages: [{ authorUserId: req.user._id, authorName: req.user.fullName, fromPlatform: false, body: b.message }],
  });
  audit(req, { action: 'support.create', entityType: 'SupportTicket', entityId: ticket._id, summary: b.subject });
  return ticket.toJSON();
});

r.get('/:id', { permission: 'support.manage', params: idParams, summary: 'Ticket with conversation' }, async req => {
  const t = await SupportTicket.findOne({ _id: req.valid.params.id, organizationId: req.ctx.orgId });
  if (!t) throw errors.notFound('Ticket');
  return t.toJSON();
});

r.post(
  '/:id/messages',
  { permission: 'support.manage', params: idParams, body: z.object({ body: requiredText(5000) }), subscription: false, summary: 'Reply on a ticket' },
  async req => {
    const t = await SupportTicket.findOne({ _id: req.valid.params.id, organizationId: req.ctx.orgId });
    if (!t) throw errors.notFound('Ticket');
    if (t.status === 'CLOSED') throw errors.conflict('This ticket is closed. Please open a new one.', 'TICKET_CLOSED');
    t.messages.push({ authorUserId: req.user._id, authorName: req.user.fullName, fromPlatform: false, body: req.valid.body.body });
    if (['WAITING_ON_CUSTOMER', 'RESOLVED'].includes(t.status)) t.status = 'OPEN';
    t.lastActivityAt = new Date();
    await t.save();
    return t.toJSON();
  },
);

r.post('/:id/close', { permission: 'support.manage', params: idParams, body: z.object({ note: text(500).optional() }), subscription: false, summary: 'Close a ticket' }, async req => {
  const t = await SupportTicket.findOne({ _id: req.valid.params.id, organizationId: req.ctx.orgId });
  if (!t) throw errors.notFound('Ticket');
  t.status = 'CLOSED';
  t.lastActivityAt = new Date();
  await t.save();
  return t.toJSON();
});

module.exports = r.router;
