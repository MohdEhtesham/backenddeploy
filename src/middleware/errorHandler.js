const env = require('../config/env');
const { codeForStatus } = require('../modules/core/errors');
const { ApiError } = require('../utils/respond');

// 404
function notFound(req, _res, next) {
  next({ status: 404, message: `Not found: ${req.method} ${req.originalUrl}` });
}

// Standard error envelope: { success:false, message, code, details, requestId }.
// `message` and `details` keep their historical meaning for existing clients.
function errorHandler(err, req, res, _next) {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Server error';
  let code = typeof err.code === 'string' ? err.code : undefined;
  let details = err.details;

  if (err.name === 'CastError') {
    status = 400;
    code = 'INVALID_ID';
    message = `Invalid ${err.path || 'id'}`;
    details = undefined;
  } else if (err.name === 'ValidationError' && err.errors) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = Object.values(err.errors).map(e => ({ path: e.path, message: e.message }));
  } else if (err.name === 'VersionError') {
    status = 409;
    code = 'CONCURRENT_UPDATE';
    message = 'This record was just updated by someone else. Please refresh and try again.';
    details = undefined;
  } else if (err.code === 11000 || err.code === 11001) {
    status = 409;
    code = 'DUPLICATE';
    message = 'A record with the same unique value already exists';
    details = { keys: Object.keys(err.keyValue || err.keyPattern || {}) };
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Malformed JSON body';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large';
  } else if (err.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = 'UPLOAD_ERROR';
    message = err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${env.MAX_UPLOAD_MB} MB)` : err.message;
  }

  if (status >= 500) {
    // Deliberate 502/503s (e.g. PAYMENTS_NOT_CONFIGURED) carry messages
    // written for users; anything else is unexpected and stays masked.
    const deliberate = err instanceof ApiError && status !== 500 && Boolean(code);
    if (deliberate) console.warn('[error]', req.requestId || '', status, code, message);
    else console.error('[error]', req.requestId || '', err);
    // Never leak internals from production.
    if (env.IS_PROD && !deliberate) {
      message = 'Server error';
      details = undefined;
    }
  }

  res.status(status).json({
    success: false,
    message,
    code: code || codeForStatus(status),
    details,
    requestId: req.requestId,
  });
}

module.exports = { notFound, errorHandler };
