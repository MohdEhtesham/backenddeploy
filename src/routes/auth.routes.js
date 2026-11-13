const router = require('express').Router();
const ctrl = require('../controllers/auth.controller');
const { authRequired } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { authLimiter } = require('../modules/core/rateLimits');
const v = require('../validators/auth');

router.post('/signup', authLimiter, validate(v.signupSchema), ctrl.signup);
router.post('/login', authLimiter, validate(v.loginSchema), ctrl.login);
router.post('/otp/send', authLimiter, validate(v.otpRequestSchema), ctrl.sendOtp);
router.post('/otp/verify', authLimiter, validate(v.otpVerifySchema), ctrl.verifyOtp);
router.post('/forgot-password', authLimiter, validate(v.forgotSchema), ctrl.forgotPassword);
router.post('/refresh', authLimiter, validate(v.refreshSchema), ctrl.refresh);

router.get('/me', authRequired, ctrl.me);
router.delete('/me', authRequired, ctrl.deleteAccount);
router.post('/logout', authRequired, ctrl.logout);
router.post('/logout-all', authRequired, ctrl.logoutAll);
router.get('/sessions', authRequired, ctrl.sessions);
router.delete('/sessions/:id', authRequired, ctrl.revokeSession);
router.put('/profile', authRequired, ctrl.updateProfile);
router.put('/role', authRequired, ctrl.setRole);
router.put('/seller/plan', authRequired, ctrl.setSellerPlan);

module.exports = router;
