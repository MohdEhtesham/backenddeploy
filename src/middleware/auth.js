const { verifyToken } = require('../utils/jwt');
const User = require('../models/User');
const { ApiError } = require('../utils/respond');

async function authRequired(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new ApiError(401, 'Authentication required');

    const payload = verifyToken(token);
    const user = await User.findById(payload.sub);
    if (!user) throw new ApiError(401, 'Invalid token');

    req.user = user;
    next();
  } catch (e) {
    next(e?.status ? e : new ApiError(401, 'Invalid or expired token'));
  }
}

function roleRequired(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'Authentication required'));
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, `Forbidden — ${roles.join('/')} only`));
    }
    next();
  };
}

module.exports = { authRequired, roleRequired };
