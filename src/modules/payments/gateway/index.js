const env = require('../../../config/env');
const { createRazorpayGateway } = require('./razorpay');

// Single active gateway. The interface (createCheckout, fetchCheckout,
// cancelCheckout, refund, verifyWebhookSignature, verifyCallbackSignature,
// parseWebhook, isConfigured) is what a Stripe / Cashfree / PayU driver
// would implement to replace Razorpay.
let gateway = null;

const getGateway = () => {
  if (!gateway) gateway = createRazorpayGateway({ ...env.RAZORPAY });
  return gateway;
};

/** Tests / alternative providers. */
const setGateway = g => {
  gateway = g;
};

module.exports = { getGateway, setGateway };
