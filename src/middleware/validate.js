const { ApiError } = require('../utils/respond');

// Validate against a Zod schema
function validate(schema, source = 'body') {
  return (req, _res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      req[source] = parsed;
      next();
    } catch (e) {
      const err = new ApiError(400, 'Validation failed', e?.issues || e?.errors || e?.message);
      err.code = 'VALIDATION_ERROR';
      next(err);
    }
  };
}

module.exports = { validate };
