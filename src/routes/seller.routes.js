const router = require('express').Router();
const ctrl = require('../controllers/seller.controller');
const { authRequired, roleRequired } = require('../middleware/auth');

router.use(authRequired, roleRequired('seller'));

// Listings
router.get('/listings', ctrl.myListings);
router.post('/listings', ctrl.createListing);
router.get('/listings/:id', ctrl.listingDetail);
router.put('/listings/:id', ctrl.updateListing);
router.put('/listings/:id/status', ctrl.setStatus);
router.delete('/listings/:id', ctrl.deleteListing);

// Leads
router.get('/leads', ctrl.leads);
router.put('/leads/:id/status', ctrl.setLeadStatus);

// Visits (booked on this seller's listings)
router.get('/visits', ctrl.visits);
router.put('/visits/:id/status', ctrl.setVisitStatus);

// Analytics
router.get('/analytics', ctrl.analytics);

module.exports = router;
