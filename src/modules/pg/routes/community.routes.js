const { createRouter } = require('../../core/router');
const { z, text, requiredText, id, idParams, listQuery, dayKey, dateRange } = require('../../core/validation');
const Notice = require('../models/Notice');
const Expense = require('../models/Expense');
const ExpenseCategory = require('../models/ExpenseCategory');
const MessMenu = require('../models/MessMenu');
const MealAttendance = require('../models/MealAttendance');
const Tenant = require('../models/Tenant');
const PgProperty = require('../models/PgProperty');
const { MEALS } = require('../models/MealAttendance');
const { crud } = require('./_crud');
const { resolveAudience } = require('../services/notices');
const { uploadSingle, storeUpload, signedUrl } = require('../../storage');
const { listOptions, paginate } = require('../../core/query');
const { loadOwned } = require('../../core/refs');
const { propertyScope, assertPropertyAccess } = require('../../core/context');
const { publicDoc } = require('../../core/schema');
const { uploadLimiter } = require('../../core/rateLimits');
const { audit } = require('../../core/audit');
const { round2 } = require('../../core/money');
const D = require('../../core/dates');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');

// ==== Notices ================================================================

const n = createRouter({ prefix: '/pg/notices', tag: 'Notices' });

const AudienceDto = z.object({
  type: z.enum(['ALL', 'PROPERTY', 'FLOOR', 'ROOM', 'TENANT']),
  propertyIds: z.array(id).max(50).optional(),
  floorIds: z.array(id).max(100).optional(),
  roomIds: z.array(id).max(300).optional(),
  tenantIds: z.array(id).max(500).optional(),
});

const NoticeDto = z.object({
  title: requiredText(140),
  body: requiredText(5000),
  category: z.enum(['GENERAL', 'MAINTENANCE', 'RENT', 'EVENT', 'RULES', 'EMERGENCY']).default('GENERAL'),
  priority: z.enum(['NORMAL', 'IMPORTANT', 'URGENT']).default('NORMAL'),
  audience: AudienceDto,
  pinned: z.boolean().optional(),
  expiresAt: dayKey.optional(),
  push: z.boolean().default(true),
});

n.get('/', { permission: 'notice.read', query: listQuery({ category: z.string().max(20).optional(), active: z.enum(['true', 'false']).optional() }), summary: 'List notices' }, async req => {
  const q = req.valid.query;
  const filter = { organizationId: req.ctx.orgId };
  if (q.category) filter.category = q.category;
  if (q.active === 'true') filter.$or = [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }];
  return paginate(Notice, filter, listOptions(q, { sortable: ['publishedAt', 'createdAt'], defaultSort: '-publishedAt', searchFields: ['title'] }), {
    select: '-recipientTenantIds',
  });
});

n.post('/', { permission: 'notice.manage', body: NoticeDto, success: 201, summary: 'Publish a notice (resolves recipients + push)' }, async req => {
  const b = req.valid.body;
  const recipients = await resolveAudience(req, b.audience);
  const notice = await Notice.create({
    organizationId: req.ctx.orgId,
    title: b.title,
    body: b.body,
    category: b.category,
    priority: b.priority,
    audience: b.audience,
    recipientTenantIds: recipients.map(t => t._id),
    recipientCount: recipients.length,
    pinned: Boolean(b.pinned),
    publishedAt: new Date(),
    expiresAt: b.expiresAt ? D.addDays(D.toDay(b.expiresAt), 1) : null,
    createdBy: req.user._id,
  });
  audit(req, { action: 'notice.publish', entityType: 'Notice', entityId: notice._id, summary: `${notice.title} → ${recipients.length} tenant(s)` });
  const userIds = recipients.map(t => t.userId).filter(Boolean);
  if (userIds.length) {
    notify({
      userIds,
      organizationId: req.ctx.orgId,
      type: 'notice',
      title: `${b.priority === 'URGENT' ? '🚨 ' : ''}${notice.title}`,
      body: notice.body.slice(0, 180),
      data: { route: 'notice', id: notice._id },
      channels: b.push ? (b.priority === 'URGENT' ? ['inapp', 'push', 'sms'] : ['inapp', 'push']) : ['inapp'],
    });
  }
  const json = notice.toJSON();
  delete json.recipientTenantIds;
  return json;
});

n.get('/:id', { permission: 'notice.read', params: idParams, summary: 'Notice' }, async req => {
  const doc = await loadOwned(Notice, req.valid.params.id, req, { entity: 'Notice', propertyField: null, lean: true });
  const out = publicDoc(doc);
  delete out.recipientTenantIds;
  return out;
});

n.put(
  '/:id',
  { permission: 'notice.manage', params: idParams, body: NoticeDto.pick({ title: true, body: true, category: true, priority: true, pinned: true, expiresAt: true }).partial(), summary: 'Edit a notice' },
  async req => {
    const doc = await loadOwned(Notice, req.valid.params.id, req, { entity: 'Notice', propertyField: null });
    const b = req.valid.body;
    doc.set({ ...b, ...(b.expiresAt ? { expiresAt: D.addDays(D.toDay(b.expiresAt), 1) } : {}) });
    await doc.save();
    audit(req, { action: 'notice.update', entityType: 'Notice', entityId: doc._id });
    const out = doc.toJSON();
    delete out.recipientTenantIds;
    return out;
  },
);

n.delete('/:id', { permission: 'notice.manage', params: idParams, summary: 'Delete a notice' }, async req => {
  const doc = await loadOwned(Notice, req.valid.params.id, req, { entity: 'Notice', propertyField: null });
  await doc.softDelete(req.user._id);
  audit(req, { action: 'notice.delete', entityType: 'Notice', entityId: doc._id });
  return { id: doc._id, deleted: true };
});

// ==== Expenses ===============================================================

const cat = createRouter({ prefix: '/pg/expense-categories', tag: 'Expenses' });

crud(cat, ExpenseCategory, {
  entity: 'Expense category',
  propertyField: null,
  feature: 'expenseManagement',
  permissions: { read: 'expense.read', create: 'expense.manage', update: 'expense.manage', delete: 'expense.manage' },
  dto: {
    list: listQuery(),
    create: z.object({ name: requiredText(60), icon: text(60).optional() }),
    update: z.object({ name: requiredText(60).optional(), icon: text(60).optional() }),
  },
  sortable: ['name', 'createdAt'],
  defaultSort: 'name',
  searchFields: ['name'],
  auditPrefix: 'expense_category',
  beforeCreate: async (_req, data) => ({ ...data, code: 'CUSTOM', isSystem: false }),
  beforeDelete: async (req, doc) => {
    if (doc.isSystem) throw errors.conflict('Built-in categories cannot be deleted.', 'SYSTEM_CATEGORY');
    if (await Expense.exists({ organizationId: req.ctx.orgId, categoryId: doc._id })) {
      throw errors.conflict('This category has expenses.', 'CATEGORY_IN_USE');
    }
  },
});

const e = createRouter({ prefix: '/pg/expenses', tag: 'Expenses' });

const ExpenseDto = z.object({
  propertyId: id.optional(),
  categoryId: id,
  amount: z.coerce.number().gt(0).max(100000000),
  date: dayKey,
  description: text(500).optional(),
  vendor: text(120).optional(),
  paymentMethod: z.enum(['CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER']).default('CASH'),
  reference: text(120).optional(),
});

const resolveCategory = async (req, data) => {
  const c0 = await ExpenseCategory.findOne({ organizationId: req.ctx.orgId, _id: data.categoryId }).lean();
  if (!c0) throw errors.notFound('Expense category');
  if (data.propertyId) {
    assertPropertyAccess(req, data.propertyId);
    if (!(await PgProperty.exists({ organizationId: req.ctx.orgId, _id: data.propertyId }))) throw errors.notFound('Property');
  }
  return { ...data, categoryName: c0.name, categoryCode: c0.code, ...(data.date ? { date: D.toDay(data.date) } : {}) };
};

crud(e, Expense, {
  entity: 'Expense',
  feature: 'expenseManagement',
  permissions: { read: 'expense.read', create: 'expense.manage', update: 'expense.manage', delete: 'expense.manage' },
  dto: {
    list: listQuery({ propertyId: id.optional(), categoryId: id.optional(), ...dateRange }),
    create: ExpenseDto,
    update: ExpenseDto.partial(),
  },
  sortable: ['date', 'amount', 'createdAt'],
  defaultSort: '-date',
  searchFields: ['description', 'vendor', 'categoryName'],
  auditPrefix: 'expense',
  listFilter: (_req, q) => {
    const f = {};
    if (q.categoryId) f.categoryId = q.categoryId;
    if (q.from || q.to) {
      f.date = {};
      if (q.from) f.date.$gte = D.toDay(q.from);
      if (q.to) f.date.$lt = D.addDays(D.toDay(q.to), 1);
    }
    return f;
  },
  decorate: async (_req, items) => items.map(x => ({ ...x, receiptKey: undefined, hasReceipt: Boolean(x.receiptKey) })),
  beforeCreate: async (req, data) => ({ ...(await resolveCategory(req, data)), createdBy: req.user._id }),
  beforeUpdate: async (req, doc, data) => (data.categoryId || data.propertyId || data.date ? resolveCategory(req, { categoryId: doc.categoryId, ...data }) : data),
});

e.get(
  '/summary/monthly',
  { permission: 'expense.read', feature: 'expenseManagement', query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), propertyId: id.optional() }), summary: 'Monthly expense summary by category' },
  async req => {
    const month = req.valid.query.month || D.dayKey(D.todayIn()).slice(0, 7);
    const start = D.parseDay(`${month}-01`);
    const rows = await Expense.aggregate([
      {
        $match: {
          organizationId: req.ctx.orgId,
          deletedAt: null,
          date: { $gte: start, $lt: D.addMonths(start, 1) },
          ...propertyScope(req, 'propertyId', req.valid.query.propertyId),
        },
      },
      { $group: { _id: '$categoryName', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]);
    return {
      month,
      total: round2(rows.reduce((t, r) => t + r.total, 0)),
      categories: rows.map(r => ({ category: r._id || 'Other', total: round2(r.total), count: r.count })),
    };
  },
);

e.post(
  '/:id/receipt',
  {
    permission: 'expense.manage',
    feature: 'expenseManagement',
    params: idParams,
    middleware: [uploadLimiter, uploadSingle('file')],
    multipart: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
    summary: 'Attach a bill / receipt (private)',
  },
  async req => {
    const doc = await loadOwned(Expense, req.valid.params.id, req, { entity: 'Expense' });
    const stored = await storeUpload(req.file, `${req.ctx.orgId}/expenses`);
    doc.receiptKey = stored.key;
    doc.receiptDriver = stored.driver;
    await doc.save();
    return { id: doc._id, hasReceipt: true };
  },
);

e.get('/:id/receipt', { permission: 'expense.read', feature: 'expenseManagement', params: idParams, summary: 'Signed URL for the receipt' }, async req => {
  const doc = await loadOwned(Expense, req.valid.params.id, req, { entity: 'Expense', lean: true });
  if (!doc.receiptKey) throw errors.notFound('Receipt');
  return signedUrl(doc.receiptKey, doc.receiptDriver);
});

// ==== Mess ===================================================================

const mess = createRouter({ prefix: '/pg/mess', tag: 'Mess' });

const MealDto = z.object({ items: z.array(z.string().trim().min(1).max(80)).max(20), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').optional() });

mess.get('/menu', { permission: 'mess.read', feature: 'messManagement', query: z.object({ propertyId: id }), summary: 'Weekly menu for a property' }, async req => {
  assertPropertyAccess(req, req.valid.query.propertyId);
  const rows = await MessMenu.find({ organizationId: req.ctx.orgId, propertyId: req.valid.query.propertyId }).sort({ dayOfWeek: 1 }).lean();
  const byDay = new Map(rows.map(r => [r.dayOfWeek, publicDoc(r)]));
  return [0, 1, 2, 3, 4, 5, 6].map(d => byDay.get(d) || { dayOfWeek: d, breakfast: { items: [], time: '08:00' }, lunch: { items: [], time: '13:00' }, dinner: { items: [], time: '20:30' }, notes: '' });
});

mess.put(
  '/menu',
  {
    permission: 'mess.manage',
    feature: 'messManagement',
    body: z.object({ propertyId: id, dayOfWeek: z.coerce.number().int().min(0).max(6), breakfast: MealDto.optional(), lunch: MealDto.optional(), dinner: MealDto.optional(), notes: text(300).optional() }),
    summary: 'Set the menu for a day of the week',
  },
  async req => {
    const b = req.valid.body;
    assertPropertyAccess(req, b.propertyId);
    if (!(await PgProperty.exists({ organizationId: req.ctx.orgId, _id: b.propertyId }))) throw errors.notFound('Property');
    const set = { updatedBy: req.user._id };
    for (const k of ['breakfast', 'lunch', 'dinner', 'notes']) if (b[k] !== undefined) set[k] = b[k];
    const doc = await MessMenu.findOneAndUpdate(
      { organizationId: req.ctx.orgId, propertyId: b.propertyId, dayOfWeek: b.dayOfWeek },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    audit(req, { action: 'mess.menu', entityType: 'MessMenu', entityId: doc._id, summary: `Day ${b.dayOfWeek}` });
    return publicDoc(doc);
  },
);

/** Kitchen headcount for a date: enrolled − opted out, served so far. */
const mealSummary = async (organizationId, propertyId, dateKey) => {
  const enrolled = await Tenant.find({ organizationId, status: { $in: ['ACTIVE', 'NOTICE'] }, messOptIn: true, 'current.propertyId': propertyId })
    .select('fullName foodPreference current')
    .lean();
  const marks = await MealAttendance.find({ organizationId, propertyId, dateKey }).lean();
  const prefs = {};
  for (const t of enrolled) prefs[t.foodPreference || 'UNSPECIFIED'] = (prefs[t.foodPreference || 'UNSPECIFIED'] || 0) + 1;
  const meals = Object.fromEntries(
    MEALS.map(meal => {
      const optedOut = marks.filter(m => m.meal === meal && m.status === 'OPTED_OUT').length;
      const consumed = marks.filter(m => m.meal === meal && m.status === 'CONSUMED').length;
      return [meal, { enrolled: enrolled.length, optedOut, expected: Math.max(0, enrolled.length - optedOut), served: consumed }];
    }),
  );
  return { date: dateKey, propertyId, enrolled: enrolled.length, foodPreferences: prefs, meals, tenants: enrolled.map(t => ({ id: t._id, fullName: t.fullName, foodPreference: t.foodPreference })), marks: marks.map(publicDoc) };
};

mess.get('/summary', { permission: 'mess.read', feature: 'messManagement', query: z.object({ propertyId: id, date: dayKey.optional() }), summary: 'Meal headcount for a day' }, async req => {
  assertPropertyAccess(req, req.valid.query.propertyId);
  const date = req.valid.query.date || D.dayKey(D.todayIn(req.ctx.org.settings && req.ctx.org.settings.timezone));
  return mealSummary(req.ctx.orgId, req.valid.query.propertyId, date);
});

mess.post(
  '/attendance',
  {
    permission: 'mess.attendance.mark',
    feature: 'messManagement',
    body: z.object({ date: dayKey, meal: z.enum(MEALS), tenantIds: z.array(id).min(1).max(500) }),
    summary: 'Mark meals served',
  },
  async req => {
    const organizationId = req.ctx.orgId;
    const b = req.valid.body;
    const tenants = await Tenant.find({ organizationId, _id: { $in: b.tenantIds }, status: { $in: ['ACTIVE', 'NOTICE'] } }).select('current').lean();
    if (tenants.length !== new Set(b.tenantIds).size) throw errors.notFound('Tenant');
    tenants.forEach(t => assertPropertyAccess(req, t.current && t.current.propertyId));
    await Promise.all(
      tenants.map(t =>
        MealAttendance.updateOne(
          { organizationId, tenantId: t._id, dateKey: b.date, meal: b.meal },
          { $set: { status: 'CONSUMED', propertyId: t.current.propertyId, date: D.toDay(b.date), markedBy: req.user._id, markedByRole: req.ctx.role } },
          { upsert: true },
        ),
      ),
    );
    return { date: b.date, meal: b.meal, marked: tenants.length };
  },
);

module.exports = {
  noticesRouter: n.router,
  expenseCategoriesRouter: cat.router,
  expensesRouter: e.router,
  messRouter: mess.router,
  mealSummary,
};
