const crypto = require('crypto');
const env = require('../../config/env');

// OpenAPI 3 generated from the same Zod DTOs that validate requests, so the
// docs can never drift from the real validation rules.

const routes = [];
const registry = {
  add: route => routes.push(route),
  all: () => routes.slice(),
};

const zodToJson = schema => {
  const def = schema && schema._def;
  if (!def) return {};
  const withDesc = out => (def.description ? { ...out, description: def.description } : out);
  switch (def.typeName) {
    case 'ZodString': {
      const s = { type: 'string' };
      for (const c of def.checks || []) {
        if (c.kind === 'min') s.minLength = c.value;
        if (c.kind === 'max') s.maxLength = c.value;
        if (c.kind === 'length') {
          s.minLength = c.value;
          s.maxLength = c.value;
        }
        if (c.kind === 'email') s.format = 'email';
        if (c.kind === 'uuid') s.format = 'uuid';
        if (c.kind === 'url') s.format = 'uri';
        if (c.kind === 'datetime') s.format = 'date-time';
        if (c.kind === 'regex') s.pattern = c.regex.source;
      }
      return withDesc(s);
    }
    case 'ZodNumber': {
      const s = { type: 'number' };
      for (const c of def.checks || []) {
        if (c.kind === 'int') s.type = 'integer';
        if (c.kind === 'min') s[c.inclusive ? 'minimum' : 'exclusiveMinimum'] = c.value;
        if (c.kind === 'max') s[c.inclusive ? 'maximum' : 'exclusiveMaximum'] = c.value;
      }
      return withDesc(s);
    }
    case 'ZodBoolean':
      return withDesc({ type: 'boolean' });
    case 'ZodDate':
      return withDesc({ type: 'string', format: 'date-time' });
    case 'ZodEnum':
      return withDesc({ type: 'string', enum: def.values });
    case 'ZodNativeEnum':
      return withDesc({ enum: Object.values(def.values) });
    case 'ZodLiteral':
      return withDesc({ enum: [def.value] });
    case 'ZodArray': {
      const s = { type: 'array', items: zodToJson(def.type) };
      if (def.minLength) s.minItems = def.minLength.value;
      if (def.maxLength) s.maxItems = def.maxLength.value;
      return withDesc(s);
    }
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const properties = {};
      const required = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJson(value);
        if (!value.isOptional()) required.push(key);
      }
      return withDesc({ type: 'object', properties, ...(required.length ? { required } : {}) });
    }
    case 'ZodOptional':
      return zodToJson(def.innerType);
    case 'ZodNullable':
      return { ...zodToJson(def.innerType), nullable: true };
    case 'ZodDefault': {
      let dflt;
      try {
        dflt = def.defaultValue();
      } catch {
        dflt = undefined;
      }
      return { ...zodToJson(def.innerType), ...(dflt !== undefined ? { default: dflt } : {}) };
    }
    case 'ZodEffects':
      return withDesc(zodToJson(def.schema));
    case 'ZodPipeline':
      return zodToJson(def.in);
    case 'ZodCatch':
    case 'ZodBranded':
    case 'ZodReadonly':
      return zodToJson(def.innerType || def.type);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return withDesc({ oneOf: [...(def.options.values ? def.options.values() : def.options)].map(zodToJson) });
    case 'ZodRecord':
      return withDesc({ type: 'object', additionalProperties: zodToJson(def.valueType) });
    default:
      return withDesc({});
  }
};

const pathParams = path => (path.match(/:([A-Za-z0-9_]+)/g) || []).map(p => p.slice(1));

const errorResponse = description => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });

const buildSpec = () => {
  const paths = {};
  for (const r of routes) {
    const openPath = r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const parameters = pathParams(r.path).map(name => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
    if (r.query) {
      const q = zodToJson(r.query);
      for (const [name, schema] of Object.entries(q.properties || {})) {
        parameters.push({ name, in: 'query', required: (q.required || []).includes(name), schema });
      }
    }
    const notes = [r.description];
    if (r.permission) notes.push(`Requires permission \`${r.permission}\`.`);
    if (r.feature) notes.push(`Requires plan feature \`${r.feature}\`.`);
    const op = {
      tags: [r.tag || 'API'],
      summary: r.summary || `${r.method.toUpperCase()} ${r.path}`,
      description: notes.filter(Boolean).join('\n\n') || undefined,
      parameters,
      responses: {
        [r.success || 200]: {
          description: 'Success',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
        },
        400: errorResponse('Validation error'),
        ...(r.auth !== 'public' ? { 401: errorResponse('Not authenticated'), 403: errorResponse('Forbidden') } : {}),
        ...(r.write && (r.auth === 'org' || r.auth === 'tenant')
          ? { 402: errorResponse('Subscription inactive / plan limit reached') }
          : {}),
        404: errorResponse('Not found'),
      },
    };
    if (r.auth === 'org' || r.auth === 'tenant') op.security = [{ bearerAuth: [], orgHeader: [] }];
    else if (r.auth !== 'public') op.security = [{ bearerAuth: [] }];
    if (r.body) {
      op.requestBody = { required: true, content: { 'application/json': { schema: zodToJson(r.body) } } };
    } else if (r.multipart) {
      op.requestBody = {
        required: true,
        content: { 'multipart/form-data': { schema: r.multipart } },
      };
    }
    paths[openPath] = paths[openPath] || {};
    paths[openPath][r.method] = op;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Aabroo API',
      version: '2.0.0',
      description:
        'Property marketplace + PG/Hostel management SaaS. All responses use the envelope ' +
        '`{ success, data, message }`; errors use `{ success:false, code, message, details, requestId }`. ' +
        'Organization-scoped endpoints need `X-Org-Id` (validated against your membership).',
    },
    servers: [{ url: `${env.PUBLIC_API_URL}/api` }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        orgHeader: { type: 'apiKey', in: 'header', name: 'X-Org-Id' },
      },
      schemas: {
        Envelope: {
          type: 'object',
          properties: { success: { type: 'boolean' }, data: {}, message: { type: 'string' } },
        },
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', enum: [false] },
            code: { type: 'string' },
            message: { type: 'string' },
            details: {},
            requestId: { type: 'string' },
          },
        },
      },
    },
    paths,
  };
};

const docsHtml = nonce => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Aabroo API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css"/>
</head><body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script nonce="${nonce}">window.ui = SwaggerUIBundle({ url: '/api/docs/openapi.json', dom_id: '#ui', persistAuthorization: true });</script>
</body></html>`;

/** Mount GET /api/docs (Swagger UI) and /api/docs/openapi.json. */
const mountDocs = app => {
  app.get('/api/docs/openapi.json', (_req, res) => res.json(buildSpec()));
  app.get('/api/docs', (_req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src 'self' https://cdn.jsdelivr.net 'nonce-${nonce}'`,
        "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
      ].join('; '),
    );
    res.type('html').send(docsHtml(nonce));
  });
};

module.exports = { registry, zodToJson, buildSpec, mountDocs };
