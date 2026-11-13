// Mount points for the PG/Hostel SaaS and shared platform modules.
//
// Everything PG lives under /api/pg/* — the marketplace already owns
// /api/properties, /api/notifications, /api/admin …, which stay untouched.

const contextRoutes = require('./saas/routes/context.routes');
const organizationRoutes = require('./saas/routes/organization.routes');
const { router: memberRoutes, invitationsRouter } = require('./saas/routes/members.routes');
const subscriptionRoutes = require('./saas/routes/subscription.routes');
const supportRoutes = require('./saas/routes/support.routes');
const adminRoutes = require('./saas/routes/admin.routes');

const propertyRoutes = require('./pg/routes/properties.routes');
const { buildingsRouter, floorsRouter } = require('./pg/routes/buildings.routes');
const roomRoutes = require('./pg/routes/rooms.routes');
const { bedsRouter, amenitiesRouter } = require('./pg/routes/beds.routes');
const tenantRoutes = require('./pg/routes/tenants.routes');
const { router: documentRoutes } = require('./pg/routes/documents.routes');
const { checkinsRouter, checkoutsRouter, agreementsRouter, rentsRouter } = require('./pg/routes/stays.routes');
const { invoicesRouter, paymentsRouter, refundsRouter } = require('./pg/routes/money.routes');
const { complaintsRouter, maintenanceRouter } = require('./pg/routes/ops.routes');
const { staffRouter, attendanceRouter } = require('./pg/routes/people.routes');
const { router: visitorRoutes } = require('./pg/routes/visitors.routes');
const { noticesRouter, expenseCategoriesRouter, expensesRouter, messRouter } = require('./pg/routes/community.routes');
const { dashboardRouter, reportsRouter, notificationsRouter, workRouter } = require('./pg/routes/insights.routes');
const meRoutes = require('./pg/routes/me.routes');

const deviceRoutes = require('./notifications/devices.routes');
const analyticsRoutes = require('./analytics/analytics.routes');
const filesRoutes = require('./storage/files.routes');
const jobsRoutes = require('./jobs/jobs.routes');

const PG_ROUTES = [
  ['/', contextRoutes], // /me/context, /organizations
  ['/me/invitations', invitationsRouter],
  ['/me', meRoutes], // tenant self-service
  ['/organization', organizationRoutes],
  ['/users', memberRoutes],
  ['/subscription', subscriptionRoutes],
  ['/support/tickets', supportRoutes],
  ['/admin', adminRoutes],
  ['/dashboard', dashboardRouter],
  ['/properties', propertyRoutes],
  ['/buildings', buildingsRouter],
  ['/floors', floorsRouter],
  ['/rooms', roomRoutes],
  ['/beds', bedsRouter],
  ['/amenities', amenitiesRouter],
  ['/tenants', tenantRoutes],
  ['/documents', documentRoutes],
  ['/agreements', agreementsRouter],
  ['/checkins', checkinsRouter],
  ['/checkouts', checkoutsRouter],
  ['/rents', rentsRouter],
  ['/invoices', invoicesRouter],
  ['/payments', paymentsRouter],
  ['/refunds', refundsRouter],
  ['/complaints', complaintsRouter],
  ['/maintenance', maintenanceRouter],
  ['/staff', staffRouter],
  ['/attendance', attendanceRouter],
  ['/visitors', visitorRoutes],
  ['/notices', noticesRouter],
  ['/expense-categories', expenseCategoriesRouter],
  ['/expenses', expensesRouter],
  ['/mess', messRouter],
  ['/reports', reportsRouter],
  ['/notifications', notificationsRouter],
  ['/work', workRouter],
];

/** Mount module routers on an Express app (DB-gated like the legacy routes). */
const mountModules = (app, requireDb) => {
  for (const [path, router] of PG_ROUTES) {
    app.use(`/api/pg${path === '/' ? '' : path}`, requireDb, router);
  }
  app.use('/api/devices', requireDb, deviceRoutes);
  app.use('/api/analytics', requireDb, analyticsRoutes);
  app.use('/api/files', filesRoutes);
  app.use('/api/internal', requireDb, jobsRoutes);
};

module.exports = { mountModules, PG_ROUTES };
