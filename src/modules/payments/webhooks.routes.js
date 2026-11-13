const express = require('express');
const env = require('../../config/env');
const WebhookEvent = require('./WebhookEvent');
const Payment = require('../pg/models/Payment');
const SubscriptionPayment = require('../saas/models/SubscriptionPayment');
const { getGateway } = require('./gateway');
const pgPayments = require('../pg/services/payments');
const saasBilling = require('../saas/services/subscriptions');
const { unscoped } = require('../core/scope');
const { escapeHtml } = require('../notifications/dispatcher');

// ---------------------------------------------------------------------------
// Gateway webhooks (mounted BEFORE the JSON parser: the signature is computed
// over the exact raw bytes).
//
//   verify HMAC → claim event id (idempotency) → route by gateway reference
//   → confirm against OUR stored amount → mark processed.
//
// Returning 500 on a processing failure makes the gateway retry; the
// failed event is re-claimed on the next delivery.
// ---------------------------------------------------------------------------

const webhooks = express.Router();

const STALE_LOCK_MS = 5 * 60 * 1000;

const claimEvent = async (provider, evt, payload) => {
  try {
    return await WebhookEvent.create({ provider, eventId: evt.eventId, event: evt.event || '', payload });
  } catch (e) {
    if (!e || e.code !== 11000) throw e;
    // Retry of a failed / abandoned attempt → take it over; else duplicate.
    return WebhookEvent.findOneAndUpdate(
      {
        provider,
        eventId: evt.eventId,
        $or: [{ status: 'FAILED' }, { status: 'PROCESSING', lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } }],
      },
      { $set: { status: 'PROCESSING', lockedAt: new Date() }, $inc: { attempts: 1 } },
      { new: true },
    );
  }
};

const dispatch = async evt => {
  switch (evt.type) {
    case 'checkout.paid': {
      const rent = await pgPayments.confirmOnlinePayment(evt);
      return rent.matched ? { kind: 'rent', ...rent } : { kind: 'subscription', ...(await saasBilling.confirmSubscriptionPayment(evt)) };
    }
    case 'checkout.closed': {
      const rent = await pgPayments.closeOnlineCheckout(evt.ref, evt.status);
      return rent.matched ? { kind: 'rent', ...rent } : { kind: 'subscription', ...(await saasBilling.closeSubscriptionCheckout(evt.ref, evt.status)) };
    }
    case 'refund.processed':
    case 'refund.failed':
      return pgPayments.onGatewayRefund(evt);
    default:
      return { ignored: true };
  }
};

webhooks.post('/razorpay', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const gateway = getGateway();
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!gateway.verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) {
    return res.status(400).json({ success: false, code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' });
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ success: false, code: 'INVALID_JSON', message: 'Malformed webhook body' });
  }

  const evt = gateway.parseWebhook(body, req.get('x-razorpay-event-id'));
  let record;
  try {
    record = await claimEvent('razorpay', evt, body);
  } catch (e) {
    console.error('[webhook] could not record event', e);
    return res.status(500).json({ success: false, code: 'WEBHOOK_STORE_FAILED' });
  }
  if (!record) return res.json({ success: true, data: { duplicate: true } });

  try {
    const result = await dispatch(evt);
    await WebhookEvent.updateOne(
      { _id: record._id },
      { $set: { status: evt.type === 'ignored' ? 'IGNORED' : 'PROCESSED', processedAt: new Date(), result, error: '' } },
    );
    return res.json({ success: true, data: { processed: true } });
  } catch (e) {
    console.error('[webhook] processing failed', evt.eventId, e);
    await WebhookEvent.updateOne({ _id: record._id }, { $set: { status: 'FAILED', error: String(e.message || e).slice(0, 500) } }).catch(() => {});
    return res.status(500).json({ success: false, code: 'WEBHOOK_PROCESSING_FAILED' });
  }
});

// ---------------------------------------------------------------------------
// Checkout return page. The browser lands here after paying; we verify the
// redirect signature, reconcile with the gateway server-to-server, then hand
// the user back to the app via deep link. Nothing is marked paid based on
// this request alone.
// ---------------------------------------------------------------------------

const payments = express.Router();

const returnPage = ({ title, message, deepLink }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="refresh" content="1;url=${escapeHtml(deepLink)}"/>
<title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0B1020;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center}
.c{max-width:360px;padding:32px}.t{font-size:22px;font-weight:800;margin:16px 0 8px}.m{color:#cbd5e1;font-size:15px;line-height:1.5}
a{display:inline-block;margin-top:24px;background:#D4AF37;color:#0B1020;font-weight:800;padding:14px 22px;border-radius:12px;text-decoration:none}</style>
</head><body><div class="c"><div style="font-size:44px">✓</div><div class="t">${escapeHtml(title)}</div>
<div class="m">${escapeHtml(message)}</div><a href="${escapeHtml(deepLink)}">Return to Aabroo</a></div></body></html>`;

payments.get('/return', async (req, res) => {
  const q = req.query || {};
  const gateway = getGateway();
  let paymentId = null;
  let kind = 'rent';
  let status = 'PENDING';
  try {
    if (gateway.isConfigured() && gateway.verifyCallbackSignature(q)) {
      const ref = String(q.razorpay_payment_link_id || '');
      const rent = await unscoped(() => Payment.findOne({ 'gateway.ref': ref }).select('_id organizationId').lean());
      if (rent) {
        paymentId = rent._id;
        status = (await pgPayments.reconcilePayment(rent.organizationId, rent._id)).status;
      } else {
        const sp = await unscoped(() => SubscriptionPayment.findOne({ 'gateway.ref': ref }).select('_id organizationId').lean());
        if (sp) {
          kind = 'subscription';
          paymentId = sp._id;
          status = (await saasBilling.reconcileSubscriptionPayment(sp.organizationId, sp._id)).status;
        }
      }
    }
  } catch (e) {
    console.warn('[payments] return reconcile failed', e.message);
  }
  const deepLink = paymentId ? `${env.APP_SCHEME}://payment/${paymentId}?kind=${kind}` : `${env.APP_SCHEME}://payment`;
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(
    returnPage(
      status === 'SUCCEEDED'
        ? { title: 'Payment received', message: 'Your payment is confirmed. Taking you back to the app…', deepLink }
        : { title: 'Almost done', message: 'We are confirming your payment with the bank. You can return to the app now.', deepLink },
    ),
  );
});

module.exports = { webhooksRouter: webhooks, paymentsReturnRouter: payments, claimEvent, dispatch };
