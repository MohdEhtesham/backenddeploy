// Socket.IO chat namespace for live 1:1 buyer↔seller messaging.
//
// Architecture mirrors the /visit-call signaling layer:
//   - JWT auth via handshake.auth.token
//   - Every authenticated socket joins a personal `user:<userId>` room so we
//     can target a user across all their open clients without tracking a
//     userId→socketId map ourselves
//   - Each chat thread doubles as a Socket.IO room (`thread:<id>`); peers
//     join after the server verifies they're a member
//
// Wire protocol:
//   client → server:  join { threadId }       acks ok|error
//                     leave { threadId }
//                     typing { threadId, on } (Chunk B)
//   server → client:  message { ... }         on every new message
//                     read { threadId, by }   when a peer acks read
//                     typing { threadId, by, on } (Chunk B)

const { Server } = require('socket.io');
const { verifyToken } = require('../utils/jwt');
const ChatThread = require('../models/ChatThread');

const USER_ROOM = userId => `user:${userId}`;
const THREAD_ROOM = threadId => `thread:${threadId}`;

let nsRef = null;

const attachChatSockets = httpServer => {
  // Reuse the existing io server (one is already created by attachSignaling
  // in sockets/signaling.js) — but Socket.IO supports multiple namespaces on
  // the same Server instance. If signaling didn't attach yet (defensive),
  // create a fresh Server here.
  let io = httpServer._io;
  if (!io) {
    io = new Server(httpServer, {
      cors: { origin: '*' },
      transports: ['websocket', 'polling'],
      pingInterval: 20000,
      pingTimeout: 25000,
    });
    httpServer._io = io;
  }

  const ns = io.of('/chat');
  nsRef = ns;

  ns.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Missing auth token'));
      const payload = verifyToken(token);
      const userId = payload.sub || payload.id || payload._id;
      if (!userId) return next(new Error('Invalid token payload'));
      socket.data.userId = String(userId);
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  ns.on('connection', socket => {
    const userId = socket.data.userId;
    socket.join(USER_ROOM(userId));

    socket.on('join', async ({ threadId } = {}, ack) => {
      if (!threadId) return ack?.({ ok: false, error: 'threadId required' });
      try {
        const t = await ChatThread.findById(threadId).select('buyerId sellerId');
        if (!t) return ack?.({ ok: false, error: 'Thread not found' });
        const me = userId;
        if (me !== String(t.buyerId) && me !== String(t.sellerId)) {
          return ack?.({ ok: false, error: 'Not a member' });
        }
        socket.join(THREAD_ROOM(threadId));
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false, error: 'invalid thread id' });
      }
    });

    socket.on('leave', ({ threadId } = {}) => {
      if (threadId) socket.leave(THREAD_ROOM(threadId));
    });

    socket.on('typing', ({ threadId, on } = {}) => {
      if (!threadId) return;
      socket.to(THREAD_ROOM(threadId)).emit('typing', {
        threadId,
        by: userId,
        on: !!on,
      });
    });

    socket.on('read', ({ threadId } = {}) => {
      if (!threadId) return;
      socket.to(THREAD_ROOM(threadId)).emit('read', { threadId, by: userId });
    });
  });

  return ns;
};

// Helper used by REST controllers (sendMessage) to fan out new messages
// over both the thread room (active subscribers) and each member's user
// room (push to anyone with the app open but not on that thread yet).
const broadcastMessage = ({ threadId, buyerId, sellerId, message }) => {
  if (!nsRef) return;
  nsRef.to(THREAD_ROOM(threadId)).emit('message', message);
  nsRef.to(USER_ROOM(buyerId)).emit('thread-touched', { threadId, message });
  nsRef.to(USER_ROOM(sellerId)).emit('thread-touched', { threadId, message });
};

module.exports = { attachChatSockets, broadcastMessage };
