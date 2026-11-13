const router = require('express').Router();
const env = require('../config/env');
const { escapeHtml } = require('./notifications/dispatcher');

// Android App Links + iOS Universal Links verification files, and a small
// fallback page for https links opened on a device without the app.

router.get('/.well-known/assetlinks.json', (_req, res) => {
  const statements = env.ANDROID_SHA256_CERT_FINGERPRINTS.length
    ? [
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: env.ANDROID_PACKAGE,
            sha256_cert_fingerprints: env.ANDROID_SHA256_CERT_FINGERPRINTS,
          },
        },
      ]
    : [];
  res.json(statements);
});

router.get('/.well-known/apple-app-site-association', (_req, res) => {
  res.type('application/json').send(
    JSON.stringify({
      applinks: {
        details: env.IOS_APP_IDS.length
          ? [
              {
                appIDs: env.IOS_APP_IDS,
                components: [{ '/': '/property/*' }, { '/': '/pg/*' }, { '/': '/tenant/*' }, { '/': '/payment/*' }],
              },
            ]
          : [],
      },
    }),
  );
});

const LINK_TYPES = ['property', 'pg', 'tenant', 'payment'];

router.get('/:type(property|pg|tenant|payment)/:id', (req, res) => {
  const { type, id } = req.params;
  if (!LINK_TYPES.includes(type) || !/^[A-Za-z0-9-]{6,64}$/.test(id)) return res.status(404).send('Not found');
  const deepLink = `${env.APP_SCHEME}://${type}/${id}`;
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Open in Aabroo</title><style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0B1020;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center}
a{display:inline-block;margin-top:20px;background:#D4AF37;color:#0B1020;font-weight:800;padding:14px 22px;border-radius:12px;text-decoration:none}</style></head>
<body><div><h2>Continue in the Aabroo app</h2><p style="color:#cbd5e1">This link opens inside the app.</p><a href="${escapeHtml(deepLink)}">Open Aabroo</a></div></body></html>`);
});

module.exports = router;
