const { ApiError } = require('../../utils/respond');

// Every error leaving the API carries a stable machine-readable `code` next
// to the human message, so clients can branch without string matching.
const make = (status, code, message, details) => {
  const e = new ApiError(status, message, details);
  e.code = code;
  return e;
};

const DEFAULT_CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'UPSTREAM_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

const codeForStatus = status => DEFAULT_CODES[status] || (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR');

module.exports = {
  make,
  codeForStatus,
  badRequest: (message = 'Bad request', code = 'BAD_REQUEST', details) => make(400, code, message, details),
  validation: details => make(400, 'VALIDATION_ERROR', 'Validation failed', details),
  unauthorized: (message = 'Authentication required', code = 'UNAUTHORIZED') => make(401, code, message),
  forbidden: (message = 'You do not have permission to perform this action', code = 'FORBIDDEN', details) =>
    make(403, code, message, details),
  notFound: (entity = 'Resource') => make(404, 'NOT_FOUND', `${entity} not found`),
  conflict: (message, code = 'CONFLICT', details) => make(409, code, message, details),
  paymentRequired: (message, code = 'PAYMENT_REQUIRED', details) => make(402, code, message, details),
  unprocessable: (message, code = 'UNPROCESSABLE', details) => make(422, code, message, details),
  tooMany: (message = 'Too many requests. Please try again later.', details) =>
    make(429, 'RATE_LIMITED', message, details),
  unavailable: (message, code = 'SERVICE_UNAVAILABLE') => make(503, code, message),
  upstream: (message, code = 'UPSTREAM_ERROR', details) => make(502, code, message, details),
};
