const env = require('../../../config/env');

// WhatsApp channel. Drivers: console (dev), meta (WhatsApp Cloud API).
// Business-initiated messages outside the 24h window must use an approved
// template — pass { template: { name, language, parameters } }.
const drivers = {
  console: {
    async send({ to, body, template }) {
      console.log(`[whatsapp:console] → ${to}: ${template ? `template:${template.name}` : body}`);
      return { ok: true, driver: 'console' };
    },
  },

  meta: {
    async send({ to, body, template }) {
      const { token, phoneNumberId } = env.WHATSAPP;
      if (!token || !phoneNumberId) throw new Error('WhatsApp Cloud API is not configured');
      const recipient = `91${String(to).replace(/^\+?91/, '')}`;
      const payload = template
        ? {
            messaging_product: 'whatsapp',
            to: recipient,
            type: 'template',
            template: {
              name: template.name,
              language: { code: template.language || 'en' },
              components: template.parameters
                ? [{ type: 'body', parameters: template.parameters.map(text => ({ type: 'text', text: String(text) })) }]
                : [],
            },
          }
        : { messaging_product: 'whatsapp', to: recipient, type: 'text', text: { body } };
      const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return { ok: true, driver: 'meta' };
    },
  },
};

let override = null;
const driver = () => override || drivers[env.WHATSAPP_PROVIDER] || drivers.console;

module.exports = {
  send: msg => driver().send(msg),
  setDriver: d => {
    override = d;
  },
  drivers,
};
