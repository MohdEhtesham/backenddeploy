const router = require('express').Router();
const ctrl = require('../controllers/inquiry.controller');
const { authRequired } = require('../middleware/auth');

router.use(authRequired);
router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.get('/:id', ctrl.detail);

module.exports = router;
