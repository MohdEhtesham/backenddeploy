const env = require('../../../config/env');

// Email channel. Drivers: console (dev), resend, sendgrid.
const drivers = {
  console: {
    async send({ to, subject, text }) {
      console.log(`[email:console] → ${to}: ${subject}\n${(text || '').slice(0, 500)}`);
      return { ok: true, driver: 'console' };
    },
  },

  resend: {
    async send({ to, subject, html, text }) {
      if (!env.EMAIL_API_KEY) throw new Error('Resend is not configured');
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return { ok: true, driver: 'resend' };
    },
  },

  sendgrid: {
    async send({ to, subject, html, text }) {
      if (!env.EMAIL_API_KEY) throw new Error('SendGrid is not configured');
      const match = /^(.*)<(.+)>$/.exec(env.EMAIL_FROM);
      const from = match ? { name: match[1].trim(), email: match[2].trim() } : { email: env.EMAIL_FROM };
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from,
          subject,
          content: [
            { type: 'text/plain', value: text || subject },
            ...(html ? [{ type: 'text/html', value: html }] : []),
          ],
        }),
      });
      if (!res.ok) throw new Error(`SendGrid ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return { ok: true, driver: 'sendgrid' };
    },
  },
};

let override = null;
const driver = () => override || drivers[env.EMAIL_PROVIDER] || drivers.console;

module.exports = {
  send: msg => driver().send(msg),
  setDriver: d => {
    override = d;
  },
  drivers,
};
