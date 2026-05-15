const router = require('express').Router();
const ctrl = require('../controllers/chat.controller');
const { authRequired } = require('../middleware/auth');

router.use(authRequired);

router.get('/threads', ctrl.listThreads);
router.post('/threads', ctrl.openThread);
router.get('/threads/:id', ctrl.getThread);
router.post('/threads/:id/messages', ctrl.sendMessage);
router.post('/threads/:id/read', ctrl.markRead);

module.exports = router;
