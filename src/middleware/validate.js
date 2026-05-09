const { ApiError } = require('../utils/respond');

// Validate against a Zod schema
function validate(schema, source = 'body') {
  return (req, _res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      req[source] = parsed;
      next();
    } catch (e) {
      next(new ApiError(400, 'Validation failed', e?.issues || e?.errors || e?.message));
    }
  };
}

module.exports = { validate };
