const router = require('express').Router();
const ctrl = require('../controllers/auth.controller');
const { authRequired } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const v = require('../validators/auth');

router.post('/signup', validate(v.signupSchema), ctrl.signup);
router.post('/login', validate(v.loginSchema), ctrl.login);
router.post('/otp/send', validate(v.otpRequestSchema), ctrl.sendOtp);
router.post('/otp/verify', validate(v.otpVerifySchema), ctrl.verifyOtp);
router.post('/forgot-password', validate(v.forgotSchema), ctrl.forgotPassword);

router.get('/me', authRequired, ctrl.me);
router.delete('/me', authRequired, ctrl.deleteAccount);
router.post('/logout', authRequired, ctrl.logout);
router.put('/profile', authRequired, ctrl.updateProfile);
router.put('/role', authRequired, ctrl.setRole);
router.put('/seller/plan', authRequired, ctrl.setSellerPlan);

module.exports = router;
