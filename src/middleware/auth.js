const { verifyToken } = require('../utils/jwt');
const User = require('../models/User');
const { ApiError } = require('../utils/respond');
const { isSessionActive } = require('../modules/auth/tokens');

const authError = (status, message, code) => {
  const e = new ApiError(status, message);
  e.code = code;
  return e;
};

async function authRequired(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw authError(401, 'Authentication required', 'UNAUTHORIZED');

    let payload;
    try {
      payload = verifyToken(token);
    } catch (e) {
      // TOKEN_EXPIRED tells refresh-capable clients to rotate silently.
      throw e && e.name === 'TokenExpiredError'
        ? authError(401, 'Invalid or expired token', 'TOKEN_EXPIRED')
        : authError(401, 'Invalid or expired token', 'TOKEN_INVALID');
    }

    // Tokens issued with a session die with it (logout, revoke, reuse).
    if (payload.sid && !(await isSessionActive(payload.sid, payload.sub))) {
      throw authError(401, 'Your session has ended. Please sign in again.', 'SESSION_REVOKED');
    }

    const user = await User.findById(payload.sub);
    if (!user) throw authError(401, 'Invalid token', 'TOKEN_INVALID');
    if (user.suspended) throw authError(403, 'This account has been suspended.', 'ACCOUNT_SUSPENDED');

    req.user = user;
    req.auth = {
      userId: String(user._id),
      sessionId: payload.sid || null,
      isSuperAdmin: user.role === 'admin',
    };
    next();
  } catch (e) {
    next(e?.status ? e : authError(401, 'Invalid or expired token', 'TOKEN_INVALID'));
  }
}

/** Attach req.user when a valid token is present; never rejects. */
async function authOptional(req, res, next) {
  if (!(req.headers.authorization || '').startsWith('Bearer ')) return next();
  authRequired(req, res, err => {
    if (err) {
      req.user = undefined;
      req.auth = undefined;
    }
    next();
  });
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

module.exports = { authRequired, authOptional, roleRequired };
