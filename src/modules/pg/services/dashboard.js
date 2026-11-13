const PgProperty = require('../models/PgProperty');
const Bed = require('../models/Bed');
const CheckIn = require('../models/CheckIn');
const CheckOut = require('../models/CheckOut');
const Tenant = require('../models/Tenant');
const Payment = require('../models/Payment');
const RentInvoice = require('../models/RentInvoice');
const Expense = require('../models/Expense');
const Complaint = require('../models/Complaint');
const MaintenanceTask = require('../models/MaintenanceTask');
const TenantDocument = require('../models/TenantDocument');
const { generateDueInvoices, refreshOverdue } = require('./invoices');
const { REPORTS, resolveRange } = require('./reports');
const { round2 } = require('../../core/money');
const D = require('../../core/dates');

// Opportunistic catch-up so numbers are right even when the external cron
// hasn't fired (e.g. free-tier hosts sleeping). Throttled per organization;
// the underlying jobs are idempotent.
const lastCatchUp = new Map();
const CATCH_UP_EVERY_MS = 30 * 60 * 1000;

const catchUp = async organizationId => {
  const last = lastCatchUp.get(organizationId) || 0;
  if (Date.now() - last < CATCH_UP_EVERY_MS) return;
  lastCatchUp.set(organizationId, Date.now());
  try {
    await generateDueInvoices(organizationId);
    await refreshOverdue(organizationId);
  } catch (e) {
    console.warn('[dashboard] catch-up failed', e.message);
  }
};

const sumField = async (Model, match, field) => {
  const [row] = await Model.aggregate([{ $match: match }, { $group: { _id: null, v: { $sum: `$${field}` } } }]);
  return row ? round2(row.v) : 0;
};

const ownerDashboard = async (req, { propertyId } = {}) => {
  const organizationId = req.ctx.orgId;
  await catchUp(organizationId);
  const tz = (req.ctx.org.settings && req.ctx.org.settings.timezone) || undefined;
  const today = D.todayIn(tz);
  const tomorrow = D.addDays(today, 1);
  const monthStart = D.startOfMonth(today);

  const scope = propertyId ? [propertyId] : req.ctx.propertyIds;
  const inScope = (field = 'propertyId') => (scope ? { [field]: { $in: scope } } : {});

  const [
    totalProperties,
    bedRows,
    todaysCheckIns,
    todaysCheckOuts,
    expectedCheckOuts,
    rentCollected,
    rentPending,
    overdueRent,
    overdueCount,
    expenses,
    openComplaints,
    urgentComplaints,
    openMaintenance,
    activeTenants,
    onNotice,
    pendingKyc,
  ] = await Promise.all([
    PgProperty.countDocuments({ organizationId, ...(scope ? { _id: { $in: scope } } : {}) }),
    Bed.aggregate([
      { $match: { organizationId, deletedAt: null, ...inScope() } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    CheckIn.countDocuments({ organizationId, checkInDate: { $gte: today, $lt: tomorrow }, ...inScope() }),
    CheckOut.countDocuments({ organizationId, checkoutDate: { $gte: today, $lt: tomorrow }, ...inScope() }),
    Tenant.countDocuments({
      organizationId,
      status: 'NOTICE',
      expectedCheckoutDate: { $gte: today, $lt: tomorrow },
      ...inScope('current.propertyId'),
    }),
    sumField(
      Payment,
      {
        organizationId,
        status: { $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] },
        method: { $ne: 'DEPOSIT_ADJUSTMENT' },
        paidAt: { $gte: monthStart, $lt: tomorrow },
        ...inScope(),
      },
      'amount',
    ),
    sumField(RentInvoice, { organizationId, status: { $in: ['PENDING', 'PARTIALLY_PAID'] }, ...inScope() }, 'balance'),
    sumField(RentInvoice, { organizationId, status: 'OVERDUE', ...inScope() }, 'balance'),
    RentInvoice.countDocuments({ organizationId, status: 'OVERDUE', ...inScope() }),
    sumField(Expense, { organizationId, deletedAt: null, date: { $gte: monthStart, $lt: tomorrow }, ...inScope() }, 'amount'),
    Complaint.countDocuments({ organizationId, status: { $in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] }, ...inScope() }),
    Complaint.countDocuments({
      organizationId,
      status: { $in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] },
      priority: { $in: ['HIGH', 'URGENT'] },
      ...inScope(),
    }),
    MaintenanceTask.countDocuments({ organizationId, status: { $in: ['CREATED', 'ASSIGNED', 'IN_PROGRESS'] }, ...inScope() }),
    Tenant.countDocuments({ organizationId, status: 'ACTIVE', ...inScope('current.propertyId') }),
    Tenant.countDocuments({ organizationId, status: 'NOTICE', ...inScope('current.propertyId') }),
    TenantDocument.countDocuments({ organizationId, status: 'PENDING' }),
  ]);

  const beds = Object.fromEntries(bedRows.map(r => [r._id, r.n]));
  const totalBeds = bedRows.reduce((t, r) => t + r.n, 0);
  const occupiedBeds = beds.OCCUPIED || 0;

  // 6-month trend (collections vs expenses) for the dashboard chart.
  const range = resolveRange({ from: D.dayKey(D.startOfMonth(D.addMonths(today, -5))), to: D.dayKey(today) }, today);
  const filters = { propertyFilter: scope && scope.length === 1 ? scope[0] : undefined, tz };
  const profit = await REPORTS.profit.fn(organizationId, filters, range);

  return {
    asOf: D.dayKey(today),
    totalProperties,
    totalBeds,
    occupiedBeds,
    availableBeds: beds.AVAILABLE || 0,
    reservedBeds: beds.RESERVED || 0,
    blockedBeds: (beds.BLOCKED || 0) + (beds.MAINTENANCE || 0),
    occupancyPct: totalBeds ? round2((occupiedBeds / totalBeds) * 100) : 0,
    todaysCheckIns,
    todaysCheckOuts,
    expectedCheckOuts,
    activeTenants,
    onNotice,
    rentCollected,
    rentPending,
    overdueRent,
    overdueInvoices: overdueCount,
    expenses,
    netRevenue: round2(rentCollected - expenses),
    openComplaints,
    urgentComplaints,
    openMaintenance,
    pendingKyc,
    trend: profit.series.map(r => ({ month: r.month, revenue: r.revenue, expenses: r.expenses, profit: r.profit })),
  };
};

module.exports = { ownerDashboard, catchUp };
