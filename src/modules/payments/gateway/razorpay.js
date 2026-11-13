const crypto = require('crypto');
const { toPaise, fromPaise } = require('../../core/money');
const { upstream } = require('../../core/errors');

const API = 'https://api.razorpay.com/v1';

const hmacHex = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

const safeEqualHex = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

/**
 * Razorpay driver built on Payment Links (hosted checkout: UPI, cards,
 * netbanking, wallets) — no native SDK needed in the app.
 *
 * `http` is injectable so tests exercise the real signing / verification
 * code against a fake HTTP layer.
 */
const createRazorpayGateway = ({ keyId, keySecret, webhookSecret, http = (...a) => globalThis.fetch(...a) }) => {
  const authHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  const call = async (method, path, body) => {
    let res;
    try {
      res = await http(`${API}${path}`, {
        method,
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw upstream('Payment gateway is unreachable. Please try again.', 'GATEWAY_UNREACHABLE', { cause: e.message });
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const description = json && json.error && json.error.description;
      throw upstream(description || `Payment gateway error (${res.status})`, 'GATEWAY_ERROR', { status: res.status });
    }
    return json;
  };

  return {
    name: 'razorpay',

    isConfigured: () => Boolean(keyId && keySecret && webhookSecret),

    /** Create a hosted checkout for `amount` rupees. */
    async createCheckout({ referenceId, amount, currency = 'INR', description, customer = {}, notes = {}, callbackUrl, expireBy }) {
      const json = await call('POST', '/payment_links', {
        amount: toPaise(amount),
        currency,
        accept_partial: false,
        reference_id: referenceId,
        description: String(description || 'Payment').slice(0, 2048),
        customer: {
          ...(customer.name ? { name: String(customer.name).slice(0, 100) } : {}),
          ...(customer.phone ? { contact: `+91${String(customer.phone).replace(/^\+?91/, '')}` } : {}),
          ...(customer.email ? { email: customer.email } : {}),
        },
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes,
        ...(callbackUrl ? { callback_url: callbackUrl, callback_method: 'get' } : {}),
        ...(expireBy ? { expire_by: Math.floor(new Date(expireBy).getTime() / 1000) } : {}),
      });
      return { ref: json.id, url: json.short_url, status: json.status };
    },

    /** Server-to-server status check (used for reconciliation). */
    async fetchCheckout(ref) {
      const json = await call('GET', `/payment_links/${encodeURIComponent(ref)}`);
      const captured = (json.payments || []).find(p => p && (p.status === 'captured' || p.status === 'paid'));
      return {
        ref: json.id,
        referenceId: json.reference_id,
        // created | partially_paid | paid | expired | cancelled
        status: json.status,
        amountPaid: fromPaise(json.amount_paid || 0),
        currency: json.currency || 'INR',
        gatewayPaymentId: captured ? captured.payment_id : null,
      };
    },

    async cancelCheckout(ref) {
      return call('POST', `/payment_links/${encodeURIComponent(ref)}/cancel`);
    },

    async refund(gatewayPaymentId, amount, notes = {}) {
      const json = await call('POST', `/payments/${encodeURIComponent(gatewayPaymentId)}/refund`, {
        amount: toPaise(amount),
        notes,
      });
      return { refundId: json.id, status: json.status };
    },

    /** Webhook authenticity: HMAC-SHA256(raw body, webhook secret). */
    verifyWebhookSignature(rawBody, signature) {
      if (!webhookSecret || !signature || !rawBody) return false;
      return safeEqualHex(hmacHex(webhookSecret, rawBody), String(signature));
    },

    /** Redirect (callback_url) authenticity: signed with the key secret. */
    verifyCallbackSignature(q) {
      if (!keySecret || !q || !q.razorpay_signature) return false;
      const payload = [
        q.razorpay_payment_link_id,
        q.razorpay_payment_link_reference_id,
        q.razorpay_payment_link_status,
        q.razorpay_payment_id,
      ].join('|');
      return safeEqualHex(hmacHex(keySecret, payload), String(q.razorpay_signature));
    },

    /** Normalize a (verified) webhook body. */
    parseWebhook(body, eventIdHeader) {
      const event = body && body.event;
      const eventId =
        eventIdHeader || crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
      const link = body && body.payload && body.payload.payment_link && body.payload.payment_link.entity;
      const payment = body && body.payload && body.payload.payment && body.payload.payment.entity;
      const refund = body && body.payload && body.payload.refund && body.payload.refund.entity;

      if (event === 'payment_link.paid' && link) {
        return {
          eventId,
          event,
          type: 'checkout.paid',
          ref: link.id,
          referenceId: link.reference_id,
          amountPaid: fromPaise(link.amount_paid || 0),
          currency: link.currency || 'INR',
          gatewayPaymentId: payment ? payment.id : null,
        };
      }
      if ((event === 'payment_link.expired' || event === 'payment_link.cancelled') && link) {
        return { eventId, event, type: 'checkout.closed', ref: link.id, status: event.split('.')[1] };
      }
      if ((event === 'refund.processed' || event === 'refund.failed') && refund) {
        return {
          eventId,
          event,
          type: event === 'refund.processed' ? 'refund.processed' : 'refund.failed',
          refundId: refund.id,
          gatewayPaymentId: refund.payment_id,
          amount: fromPaise(refund.amount || 0),
        };
      }
      return { eventId, event, type: 'ignored' };
    },
  };
};

module.exports = { createRazorpayGateway, hmacHex };
