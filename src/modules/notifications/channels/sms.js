const env = require('../../../config/env');

// SMS channel. Drivers: console (dev), twilio, msg91 (India, DLT templates).
const drivers = {
  console: {
    async send(to, body) {
      console.log(`[sms:console] → ${to}: ${body}`);
      return { ok: true, driver: 'console' };
    },
  },

  twilio: {
    async send(to, body) {
      const { accountSid, authToken, from } = env.TWILIO;
      if (!accountSid || !authToken || !from) throw new Error('Twilio is not configured');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to.startsWith('+') ? to : `+91${to}`, From: from, Body: body }),
      });
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      return { ok: true, driver: 'twilio', id: json.sid };
    },
  },

  msg91: {
    // MSG91 Flow API — Indian regulations (DLT) require pre-approved templates.
    async send(to, _body, { templateId, variables } = {}) {
      const { authKey } = env.MSG91;
      const tid = templateId || env.MSG91.templateId;
      if (!authKey || !tid) throw new Error('MSG91 is not configured');
      const res = await fetch('https://control.msg91.com/api/v5/flow', {
        method: 'POST',
        headers: { authkey: authKey, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          template_id: tid,
          short_url: '0',
          recipients: [{ mobiles: `91${to.replace(/^\+?91/, '')}`, ...(variables || {}) }],
        }),
      });
      if (!res.ok) throw new Error(`MSG91 ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return { ok: true, driver: 'msg91' };
    },
  },
};

let override = null;
const driver = () => override || drivers[env.SMS_PROVIDER] || drivers.console;

module.exports = {
  send: (to, body, opts) => driver().send(to, body, opts),
  sendOtp: (to, code) => {
    const minutes = Math.max(1, Math.round(env.OTP_TTL_SECONDS / 60));
    const body = `${code} is your Aabroo verification code. It expires in ${minutes} min. Do not share it with anyone.`;
    return driver().send(to, body, { templateId: env.MSG91.otpTemplateId, variables: { otp: code } });
  },
  /** Tests: capture outgoing messages. */
  setDriver: d => {
    override = d;
  },
  drivers,
};
