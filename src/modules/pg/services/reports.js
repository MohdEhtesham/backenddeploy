const Bed = require('../models/Bed');
const BedAllocation = require('../models/BedAllocation');
const Payment = require('../models/Payment');
const RentInvoice = require('../models/RentInvoice');
const Expense = require('../models/Expense');
const CheckIn = require('../models/CheckIn');
const CheckOut = require('../models/CheckOut');
const Complaint = require('../models/Complaint');
const MaintenanceTask = require('../models/MaintenanceTask');
const Tenant = require('../models/Tenant');
const PgProperty = require('../models/PgProperty');
const { round2 } = require('../../core/money');
const D = require('../../core/dates');

// Every report returns { summary, series?, table: { columns, rows } } —
// the `table` shape is what CSV export (and the app's DataTable) consume.

// Date-only fields are stored at UTC midnight → group them in UTC; real
// timestamps (paidAt, createdAt) are grouped in the organization's zone.
const monthOf = (field, tz = 'UTC') => ({ $dateToString: { format: '%Y-%m', date: `$${field}`, timezone: tz } });

/** Inclusive calendar range → [from 00:00, to+1 00:00). Defaults: last 6 months. */
const resolveRange = ({ from, to }, today) => {
  const end = to ? D.toDay(to) : today;
  const start = from ? D.toDay(from) : D.startOfMonth(D.addMonths(end, -5));
  return { start, endExclusive: D.addDays(end, 1), from: D.dayKey(start), to: D.dayKey(end) };
};

const monthsBetween = (start, endExclusive) => {
  const out = [];
  let cur = D.startOfMonth(start);
  let guard = 0;
  while (cur < endExclusive && guard++ < 60) {
    out.push(D.dayKey(cur).slice(0, 7));
    cur = D.addMonths(cur, 1);
  }
  return out;
};

const propertyMatch = (scope, field = 'propertyId') => (scope ? { [field]: scope } : {});

// ---------------------------------------------------------------------------

const occupancy = async (organizationId, { propertyFilter }, range) => {
  const beds = await Bed.aggregate([
    { $match: { organizationId, deletedAt: null, ...propertyMatch(propertyFilter) } },
    { $group: { _id: { p: '$propertyId', s: '$status' }, n: { $sum: 1 } } },
  ]);
  const props = await PgProperty.find({ organizationId, ...(propertyFilter ? { _id: propertyFilter } : {}) })
    .select('name')
    .lean();
  const byProp = new Map(props.map(p => [p._id, { propertyId: p._id, property: p.name, totalBeds: 0, occupied: 0, available: 0, reserved: 0, blocked: 0 }]));
  for (const r of beds) {
    const row = byProp.get(r._id.p);
    if (!row) continue;
    row.totalBeds += r.n;
    if (r._id.s === 'OCCUPIED') row.occupied += r.n;
    else if (r._id.s === 'AVAILABLE') row.available += r.n;
    else if (r._id.s === 'RESERVED') row.reserved += r.n;
    else row.blocked += r.n;
  }
  const rows = [...byProp.values()].map(r => ({ ...r, occupancyPct: r.totalBeds ? round2((r.occupied / r.totalBeds) * 100) : 0 }));
  const totalBeds = rows.reduce((t, r) => t + r.totalBeds, 0);
  const occupied = rows.reduce((t, r) => t + r.occupied, 0);

  // Month-end occupancy from the allocation history.
  const months = monthsBetween(range.start, range.endExclusive);
  const allocations = await BedAllocation.find({
    organizationId,
    ...propertyMatch(propertyFilter),
    startDate: { $lt: range.endExclusive },
    $or: [{ endDate: null }, { endDate: { $gte: range.start } }],
  })
    .select('startDate endDate')
    .lean();
  const series = months.map(m => {
    const monthEnd = D.addDays(D.addMonths(D.parseDay(`${m}-01`), 1), -1);
    const at = monthEnd < range.endExclusive ? monthEnd : D.addDays(range.endExclusive, -1);
    const occ = allocations.filter(a => a.startDate <= at && (!a.endDate || a.endDate >= at)).length;
    return { month: m, occupied: occ, occupancyPct: totalBeds ? round2((occ / totalBeds) * 100) : 0 };
  });

  return {
    summary: { totalBeds, occupied, available: totalBeds - occupied, occupancyPct: totalBeds ? round2((occupied / totalBeds) * 100) : 0 },
    series,
    table: {
      columns: [
        { key: 'property', label: 'Property' },
        { key: 'totalBeds', label: 'Beds' },
        { key: 'occupied', label: 'Occupied' },
        { key: 'available', label: 'Available' },
        { key: 'reserved', label: 'Reserved' },
        { key: 'blocked', label: 'Blocked / maintenance' },
        { key: 'occupancyPct', label: 'Occupancy %' },
      ],
      rows,
    },
  };
};

/** Cash-basis collections split by what the money paid for. */
const collectionsByMonth = async (organizationId, propertyFilter, range, tz = 'UTC') => {
  const rows = await Payment.aggregate([
    {
      $match: {
        organizationId,
        status: { $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        method: { $ne: 'DEPOSIT_ADJUSTMENT' },
        paidAt: { $gte: range.start, $lt: range.endExclusive },
        ...propertyMatch(propertyFilter),
      },
    },
    {
      $project: {
        month: monthOf('paidAt', tz),
        method: 1,
        amount: 1,
        refundedAmount: 1,
        unappliedAmount: 1,
        allocations: 1,
      },
    },
    { $unwind: { path: '$allocations', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'pg_invoices', localField: 'allocations.invoiceId', foreignField: '_id', as: 'inv' } },
    {
      $group: {
        _id: { month: '$month', kind: { $ifNull: [{ $arrayElemAt: ['$inv.kind', 0] }, 'NONE'] } },
        allocated: { $sum: { $ifNull: ['$allocations.amount', 0] } },
      },
    },
  ]);
  const totals = await Payment.aggregate([
    {
      $match: {
        organizationId,
        status: { $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        method: { $ne: 'DEPOSIT_ADJUSTMENT' },
        paidAt: { $gte: range.start, $lt: range.endExclusive },
        ...propertyMatch(propertyFilter),
      },
    },
    {
      $group: {
        _id: { month: monthOf('paidAt', tz), method: '$method' },
        received: { $sum: '$amount' },
        refunded: { $sum: '$refundedAmount' },
        count: { $sum: 1 },
      },
    },
  ]);
  return { rows, totals };
};

const revenue = async (organizationId, { propertyFilter, tz }, range) => {
  const { rows, totals } = await collectionsByMonth(organizationId, propertyFilter, range, tz);
  const months = monthsBetween(range.start, range.endExclusive);
  const base = () => ({ rent: 0, deposits: 0, other: 0, advance: 0, received: 0, refunded: 0, net: 0, payments: 0 });
  const byMonth = new Map(months.map(m => [m, { month: m, ...base() }]));
  const methods = {};
  for (const r of totals) {
    const row = byMonth.get(r._id.month);
    if (!row) continue;
    row.received = round2(row.received + r.received);
    row.refunded = round2(row.refunded + r.refunded);
    row.payments += r.count;
    methods[r._id.method] = round2((methods[r._id.method] || 0) + r.received);
  }
  for (const r of rows) {
    const row = byMonth.get(r._id.month);
    if (!row) continue;
    if (r._id.kind === 'RENT') row.rent = round2(row.rent + r.allocated);
    else if (r._id.kind === 'DEPOSIT') row.deposits = round2(row.deposits + r.allocated);
    else if (r._id.kind !== 'NONE') row.other = round2(row.other + r.allocated);
  }
  for (const row of byMonth.values()) {
    row.advance = round2(Math.max(0, row.received - row.rent - row.deposits - row.other));
    // Revenue excludes refundable deposits and money returned.
    row.net = round2(row.received - row.deposits - row.refunded);
  }
  const series = [...byMonth.values()];
  const sumOf = k => round2(series.reduce((t, r) => t + r[k], 0));
  return {
    summary: {
      received: sumOf('received'),
      rent: sumOf('rent'),
      deposits: sumOf('deposits'),
      other: sumOf('other'),
      advance: sumOf('advance'),
      refunded: sumOf('refunded'),
      revenue: sumOf('net'),
      byMethod: methods,
    },
    series,
    table: {
      columns: [
        { key: 'month', label: 'Month' },
        { key: 'received', label: 'Received' },
        { key: 'rent', label: 'Rent' },
        { key: 'other', label: 'Other charges' },
        { key: 'deposits', label: 'Deposits' },
        { key: 'advance', label: 'Advance' },
        { key: 'refunded', label: 'Refunded' },
        { key: 'net', label: 'Revenue' },
        { key: 'payments', label: 'Payments' },
      ],
      rows: series,
    },
  };
};

const rentCollection = async (organizationId, { propertyFilter }, range) => {
  const rows = await RentInvoice.aggregate([
    {
      $match: {
        organizationId,
        kind: { $in: ['RENT', 'ADHOC', 'SETTLEMENT'] },
        status: { $ne: 'CANCELLED' },
        issueDate: { $gte: range.start, $lt: range.endExclusive },
        ...propertyMatch(propertyFilter),
      },
    },
    {
      $group: {
        _id: monthOf('issueDate'),
        invoiced: { $sum: '$total' },
        collected: { $sum: '$amountPaid' },
        outstanding: { $sum: '$balance' },
        invoices: { $sum: 1 },
        paid: { $sum: { $cond: [{ $eq: ['$status', 'PAID'] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const series = rows.map(r => ({
    month: r._id,
    invoiced: round2(r.invoiced),
    collected: round2(r.collected),
    outstanding: round2(r.outstanding),
    invoices: r.invoices,
    paidInvoices: r.paid,
    collectionRate: r.invoiced ? round2((r.collected / r.invoiced) * 100) : 0,
  }));
  const invoiced = round2(series.reduce((t, r) => t + r.invoiced, 0));
  const collected = round2(series.reduce((t, r) => t + r.collected, 0));
  return {
    summary: {
      invoiced,
      collected,
      outstanding: round2(invoiced - collected),
      collectionRate: invoiced ? round2((collected / invoiced) * 100) : 0,
    },
    series,
    table: {
      columns: [
        { key: 'month', label: 'Month' },
        { key: 'invoices', label: 'Invoices' },
        { key: 'invoiced', label: 'Invoiced' },
        { key: 'collected', label: 'Collected' },
        { key: 'outstanding', label: 'Outstanding' },
        { key: 'collectionRate', label: 'Collection %' },
      ],
      rows: series,
    },
  };
};

const overdue = async (organizationId, { propertyFilter }, _range, today) => {
  const invoices = await RentInvoice.find({
    organizationId,
    status: { $in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] },
    balance: { $gt: 0 },
    dueDate: { $lt: today },
    ...propertyMatch(propertyFilter),
  })
    .sort({ dueDate: 1 })
    .lean();
  const tenants = await Tenant.find({ organizationId, _id: { $in: [...new Set(invoices.map(i => i.tenantId))] } })
    .select('fullName phone status')
    .lean();
  const tenantOf = new Map(tenants.map(t => [t._id, t]));
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const rows = invoices.map(i => {
    const days = D.diffDays(i.dueDate, today);
    const bucket = days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
    buckets[bucket] = round2(buckets[bucket] + i.balance);
    const t = tenantOf.get(i.tenantId) || {};
    return {
      invoiceId: i._id,
      invoiceNumber: i.invoiceNumber,
      tenantId: i.tenantId,
      tenant: t.fullName || '',
      tenantStatus: t.status || '',
      dueDate: D.dayKey(i.dueDate),
      daysOverdue: days,
      bucket,
      balance: i.balance,
    };
  });
  return {
    summary: { totalOverdue: round2(rows.reduce((t, r) => t + r.balance, 0)), invoices: rows.length, buckets },
    table: {
      columns: [
        { key: 'invoiceNumber', label: 'Invoice' },
        { key: 'tenant', label: 'Tenant' },
        { key: 'dueDate', label: 'Due date' },
        { key: 'daysOverdue', label: 'Days overdue' },
        { key: 'bucket', label: 'Bucket' },
        { key: 'balance', label: 'Balance' },
      ],
      rows,
    },
  };
};

const expenses = async (organizationId, { propertyFilter }, range) => {
  const rows = await Expense.aggregate([
    { $match: { organizationId, deletedAt: null, date: { $gte: range.start, $lt: range.endExclusive }, ...propertyMatch(propertyFilter) } },
    { $group: { _id: { month: monthOf('date'), category: '$categoryName' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const months = monthsBetween(range.start, range.endExclusive);
  const byMonth = new Map(months.map(m => [m, { month: m, total: 0 }]));
  const byCategory = {};
  for (const r of rows) {
    const row = byMonth.get(r._id.month);
    if (row) row.total = round2(row.total + r.amount);
    byCategory[r._id.category || 'Other'] = round2((byCategory[r._id.category || 'Other'] || 0) + r.amount);
  }
  const table = Object.entries(byCategory)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
  return {
    summary: { total: round2(table.reduce((t, r) => t + r.amount, 0)), byCategory },
    series: [...byMonth.values()],
    table: { columns: [{ key: 'category', label: 'Category' }, { key: 'amount', label: 'Amount' }], rows: table },
  };
};

const profit = async (organizationId, filters, range) => {
  const [rev, exp] = await Promise.all([revenue(organizationId, filters, range), expenses(organizationId, filters, range)]);
  const expOf = new Map(exp.series.map(r => [r.month, r.total]));
  const series = rev.series.map(r => {
    const e = expOf.get(r.month) || 0;
    return { month: r.month, revenue: r.net, expenses: e, profit: round2(r.net - e), margin: r.net ? round2(((r.net - e) / r.net) * 100) : 0 };
  });
  const totalRevenue = rev.summary.revenue;
  const totalExpenses = exp.summary.total;
  return {
    summary: {
      revenue: totalRevenue,
      expenses: totalExpenses,
      profit: round2(totalRevenue - totalExpenses),
      margin: totalRevenue ? round2(((totalRevenue - totalExpenses) / totalRevenue) * 100) : 0,
    },
    series,
    table: {
      columns: [
        { key: 'month', label: 'Month' },
        { key: 'revenue', label: 'Revenue' },
        { key: 'expenses', label: 'Expenses' },
        { key: 'profit', label: 'Net profit' },
        { key: 'margin', label: 'Margin %' },
      ],
      rows: series,
    },
  };
};

const tenantMovement = async (organizationId, { propertyFilter }, range) => {
  const match = { organizationId, ...propertyMatch(propertyFilter) };
  const [ins, outs] = await Promise.all([
    CheckIn.aggregate([
      { $match: { ...match, checkInDate: { $gte: range.start, $lt: range.endExclusive } } },
      { $group: { _id: monthOf('checkInDate'), n: { $sum: 1 } } },
    ]),
    CheckOut.aggregate([
      { $match: { ...match, checkoutDate: { $gte: range.start, $lt: range.endExclusive } } },
      { $group: { _id: monthOf('checkoutDate'), n: { $sum: 1 } } },
    ]),
  ]);
  const inOf = new Map(ins.map(r => [r._id, r.n]));
  const outOf = new Map(outs.map(r => [r._id, r.n]));
  const series = monthsBetween(range.start, range.endExclusive).map(m => ({
    month: m,
    checkIns: inOf.get(m) || 0,
    checkOuts: outOf.get(m) || 0,
    net: (inOf.get(m) || 0) - (outOf.get(m) || 0),
  }));
  const onNotice = await Tenant.countDocuments({ organizationId, status: 'NOTICE', ...propertyMatch(propertyFilter, 'current.propertyId') });
  return {
    summary: {
      checkIns: series.reduce((t, r) => t + r.checkIns, 0),
      checkOuts: series.reduce((t, r) => t + r.checkOuts, 0),
      onNotice,
    },
    series,
    table: {
      columns: [
        { key: 'month', label: 'Month' },
        { key: 'checkIns', label: 'Check-ins' },
        { key: 'checkOuts', label: 'Check-outs' },
        { key: 'net', label: 'Net change' },
      ],
      rows: series,
    },
  };
};

const workStats = async (Model, organizationId, propertyFilter, range, openStatuses) => {
  const match = { organizationId, createdAt: { $gte: range.start, $lt: range.endExclusive }, ...propertyMatch(propertyFilter) };
  const [byStatus, byCategory, resolution] = await Promise.all([
    Model.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Model.aggregate([{ $match: match }, { $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    Model.aggregate([
      { $match: { ...match, resolvedAt: { $ne: null } } },
      { $group: { _id: null, avgMs: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } }, n: { $sum: 1 } } },
    ]),
  ]);
  const statusCounts = Object.fromEntries(byStatus.map(r => [r._id, r.n]));
  const total = byStatus.reduce((t, r) => t + r.n, 0);
  const open = openStatuses.reduce((t, s) => t + (statusCounts[s] || 0), 0);
  return {
    summary: {
      total,
      open,
      resolved: total - open,
      byStatus: statusCounts,
      avgResolutionHours: resolution[0] ? round2(resolution[0].avgMs / 3600000) : null,
    },
    table: {
      columns: [
        { key: 'category', label: 'Category' },
        { key: 'count', label: 'Count' },
      ],
      rows: byCategory.map(r => ({ category: r._id, count: r.n })),
    },
  };
};

const complaints = (organizationId, { propertyFilter }, range) =>
  workStats(Complaint, organizationId, propertyFilter, range, ['OPEN', 'ASSIGNED', 'IN_PROGRESS']);

const maintenance = async (organizationId, { propertyFilter }, range) => {
  const stats = await workStats(MaintenanceTask, organizationId, propertyFilter, range, ['CREATED', 'ASSIGNED', 'IN_PROGRESS']);
  const cost = await MaintenanceTask.aggregate([
    { $match: { organizationId, createdAt: { $gte: range.start, $lt: range.endExclusive }, ...propertyMatch(propertyFilter) } },
    { $group: { _id: null, estimated: { $sum: '$estimatedCost' }, actual: { $sum: '$actualCost' } } },
  ]);
  stats.summary.estimatedCost = cost[0] ? round2(cost[0].estimated) : 0;
  stats.summary.actualCost = cost[0] ? round2(cost[0].actual) : 0;
  return stats;
};

const paymentHistory = async (organizationId, { propertyFilter, method, status }, range) => {
  const match = {
    organizationId,
    paidAt: { $gte: range.start, $lt: range.endExclusive },
    ...propertyMatch(propertyFilter),
    ...(method ? { method } : {}),
    ...(status ? { status } : { status: { $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }),
  };
  const payments = await Payment.find(match).sort({ paidAt: -1 }).limit(5000).lean();
  const tenants = await Tenant.find({ organizationId, _id: { $in: [...new Set(payments.map(p => p.tenantId))] } })
    .select('fullName')
    .lean();
  const nameOf = new Map(tenants.map(t => [t._id, t.fullName]));
  const rows = payments.map(p => ({
    paymentId: p._id,
    receiptNumber: p.receiptNumber,
    paidAt: p.paidAt ? p.paidAt.toISOString() : '',
    tenant: nameOf.get(p.tenantId) || '',
    method: p.method,
    status: p.status,
    amount: p.amount,
    refunded: p.refundedAmount || 0,
    reference: p.reference || (p.gateway && p.gateway.paymentId) || '',
  }));
  return {
    summary: {
      count: rows.length,
      total: round2(rows.filter(r => r.method !== 'DEPOSIT_ADJUSTMENT').reduce((t, r) => t + r.amount, 0)),
      refunded: round2(rows.reduce((t, r) => t + r.refunded, 0)),
    },
    table: {
      columns: [
        { key: 'receiptNumber', label: 'Receipt' },
        { key: 'paidAt', label: 'Paid at' },
        { key: 'tenant', label: 'Tenant' },
        { key: 'method', label: 'Method' },
        { key: 'status', label: 'Status' },
        { key: 'amount', label: 'Amount' },
        { key: 'refunded', label: 'Refunded' },
        { key: 'reference', label: 'Reference' },
      ],
      rows,
    },
  };
};

const REPORTS = {
  occupancy: { fn: occupancy, advanced: false, title: 'Occupancy' },
  revenue: { fn: revenue, advanced: false, title: 'Revenue' },
  'rent-collection': { fn: rentCollection, advanced: false, title: 'Rent collection' },
  overdue: { fn: overdue, advanced: false, title: 'Overdue rent' },
  expenses: { fn: expenses, advanced: false, title: 'Expenses' },
  profit: { fn: profit, advanced: true, title: 'Profit & net revenue' },
  'tenant-movement': { fn: tenantMovement, advanced: true, title: 'Tenant movement' },
  complaints: { fn: complaints, advanced: true, title: 'Complaints' },
  maintenance: { fn: maintenance, advanced: true, title: 'Maintenance' },
  payments: { fn: paymentHistory, advanced: false, title: 'Payment history' },
};

module.exports = { REPORTS, resolveRange, monthsBetween, collectionsByMonth };
