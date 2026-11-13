const jwt = require('jsonwebtoken');
const env = require('../../config/env');
const { isSessionActive } = require('./tokens');

/**
 * Verify a Socket.IO handshake token.
 *
 * Long-lived sockets (chat, incoming-call listener, active WebRTC calls)
 * hold on to the token they connected with. Clients refresh access tokens
 * silently in the background, so a reconnect may present an access token
 * that expired minutes ago. That is accepted ONLY when the token is
 * genuine and carries a session id whose session is still active (not
 * logged out / revoked / past its absolute lifetime) — revocation remains
 * immediate. Legacy tokens without a session keep strict expiry.
 */
const verifySocketToken = async token => {
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch (e) {
    if (e && e.name === 'TokenExpiredError') {
      payload = jwt.verify(token, env.JWT_SECRET, { ignoreExpiration: true });
      if (!payload.sid) throw e;
    } else {
      throw e;
    }
  }
  if (payload.sid && !(await isSessionActive(payload.sid, payload.sub))) {
    throw new Error('Session revoked');
  }
  return payload;
};

module.exports = { verifySocketToken };
