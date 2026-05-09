const { fail } = require('../utils/respond');

// 404
function notFound(req, _res, next) {
  next({ status: 404, message: `Not found: ${req.method} ${req.originalUrl}` });
}

function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) {
    console.error('[error]', err);
  }
  fail(res, status, err.message || 'Server error', err.details);
}

module.exports = { notFound, errorHandler };
