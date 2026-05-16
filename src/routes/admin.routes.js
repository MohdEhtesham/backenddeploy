const router = require('express').Router();
const ctrl = require('../controllers/admin.controller');
const { authRequired, roleRequired } = require('../middleware/auth');

// Bootstrap (public) — only works while no admin exists in the DB.
// Self-disabling: once any user has role='admin', subsequent calls return 403.
router.post('/bootstrap', ctrl.bootstrap);

// Every other route under /api/admin/* is locked to admins.
router.use(authRequired, roleRequired('admin'));

// Dashboard
router.get('/dashboard', ctrl.dashboard);

// Users
router.get('/users', ctrl.listUsers);
router.get('/users/:id', ctrl.getUser);
router.put('/users/:id', ctrl.updateUser);
router.delete('/users/:id', ctrl.deleteUser);

// Listings (properties)
router.get('/listings', ctrl.listListings);
router.get('/listings/:id', ctrl.getListing);
router.put('/listings/:id', ctrl.updateListing);
router.delete('/listings/:id', ctrl.deleteListing);

// Leads
router.get('/leads', ctrl.listLeads);
router.get('/leads/:id', ctrl.getLead);
router.delete('/leads/:id', ctrl.deleteLead);

// Visits
router.get('/visits', ctrl.listVisits);
router.get('/visits/:id', ctrl.getVisit);
router.delete('/visits/:id', ctrl.deleteVisit);

// Inquiries
router.get('/inquiries', ctrl.listInquiries);
router.get('/inquiries/:id', ctrl.getInquiry);
router.delete('/inquiries/:id', ctrl.deleteInquiry);

// Notifications
router.get('/notifications', ctrl.listNotifications);
router.delete('/notifications/:id', ctrl.deleteNotification);

module.exports = router;
