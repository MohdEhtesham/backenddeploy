const router = require('express').Router();
const ctrl = require('../controllers/visit.controller');
const { authRequired } = require('../middleware/auth');

router.use(authRequired);
router.get('/slots', ctrl.slots);
router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.get('/:id', ctrl.detail);
router.put('/:id/cancel', ctrl.cancel);
router.put('/:id/reschedule', ctrl.reschedule);

module.exports = router;
