const router = require('express').Router();
const ctrl = require('../controllers/property.controller');
const { authRequired } = require('../middleware/auth');

router.get('/featured', ctrl.featured);
router.get('/trending', ctrl.trending);
router.get('/recommended', ctrl.recommended);
router.get('/search', ctrl.search);
router.get('/saved', authRequired, ctrl.savedList);
router.post('/:id/save', authRequired, ctrl.toggleSave);
router.get('/:id/similar', ctrl.similar);
router.get('/:id', ctrl.detail);
router.get('/', ctrl.list);

module.exports = router;
