const express = require('express');
const { authRequired, authOptional } = require('../../middleware/auth');
const { registry } = require('./openapi');
const { validate } = require('./validation');
const ctx = require('./context');

/**
 * Declarative route builder — the Express equivalent of Nest controllers:
 *
 *   r.post('/', { permission: 'room.create', body: CreateRoomDto, summary }, handler)
 *
 * composes, in order: authentication → organization context → RBAC →
 * plan feature → writable subscription → Zod validation → handler, and
 * registers the route in the OpenAPI document. Handlers return data; the
 * builder wraps it in the standard { success, data } envelope.
 *
 * auth modes:
 *   'org'        signed-in member of an organization (default)
 *   'tenant'     signed-in resident (TENANT membership)
 *   'user'       signed-in, no organization needed
 *   'superadmin' platform administrator
 *   'optional'   public, user attached when a token is sent
 *   'public'     no authentication
 */
const createRouter = ({ prefix = '', tag = 'API' } = {}) => {
  const router = express.Router();

  const add = method => (path, def, handler) => {
    const {
      auth = 'org',
      permission,
      anyPermission,
      feature,
      body,
      query,
      params,
      summary,
      description,
      success = 200,
      raw = false,
      middleware = [],
      multipart,
      subscription = true,
    } = def;
    const write = def.write !== undefined ? def.write : method !== 'get';

    const chain = [];
    if (auth === 'optional') chain.push(authOptional);
    else if (auth !== 'public') chain.push(authRequired);
    if (auth === 'org' || auth === 'tenant') chain.push(ctx.orgContext);
    if (auth === 'superadmin') chain.push(ctx.requireSuperAdmin);
    if (auth === 'tenant') chain.push(ctx.requireTenantSelf);
    if (permission) chain.push(ctx.requirePermission(permission));
    if (anyPermission) chain.push(ctx.requireAnyPermission(anyPermission));
    if (feature) chain.push(ctx.requireFeature(feature));
    if (write && subscription && (auth === 'org' || auth === 'tenant')) chain.push(ctx.requireWritableSubscription);
    chain.push(...middleware);
    if (params) chain.push(validate(params, 'params'));
    if (query) chain.push(validate(query, 'query'));
    if (body) chain.push(validate(body, 'body'));

    chain.push(async (req, res, next) => {
      try {
        req.valid = req.valid || {};
        const result = await handler(req, res);
        if (raw || res.headersSent) return;
        res.status(success).json({ success: true, data: result === undefined ? null : result });
      } catch (e) {
        next(e);
      }
    });

    router[method](path, ...chain);
    registry.add({
      method,
      path: `${prefix}${path === '/' ? '' : path}` || prefix,
      tag,
      summary,
      description,
      auth,
      permission,
      feature,
      body,
      query,
      multipart,
      success,
      write,
    });
  };

  return {
    router,
    get: add('get'),
    post: add('post'),
    put: add('put'),
    patch: add('patch'),
    delete: add('delete'),
  };
};

module.exports = { createRouter };
