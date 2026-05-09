const router = require('express').Router();
const ctrl = require('../controllers/chat.controller');
const { authRequired } = require('../middleware/auth');

router.use(authRequired);
router.get('/thread', ctrl.thread);
router.post('/send', ctrl.send);
router.post('/callback', ctrl.requestCallback);

module.exports = router;
