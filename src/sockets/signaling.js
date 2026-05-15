// WebRTC signaling for virtual property visits.
//
// Architecture:
//   - Each Visit document is its own "room" — the room id is the visit id.
//   - Only the booked buyer (visit.consumerId) and the property owner
//     (visit.propertyOwnerId) are allowed to join.
//   - Authentication is via JWT in handshake.auth.token (or query.token).
//   - Once both peers are present, they exchange offer / answer / ICE
//     candidates through the server. The server is purely a relay — no
//     media flows through it, so this is cheap to host and scales to many
//     concurrent calls on Render's free tier.
//
// Client events (incoming):
//   join         { visitId }                  → joins the room
//   signal       { to, data }                 → relayed to peer with `to` socket id
//   leave        { visitId }                  → leaves the room
//
// Server events (outgoing):
//   joined        { peers: string[], self }   → ack with the list of currently-present peer socket ids
//   peer-joined   { socketId, role }          → broadcast when a new peer joins
//   peer-left     { socketId }                → broadcast when a peer leaves / disconnects
//   signal        { from, data }              → forwarded signaling payload
//   error         { message }                 → fatal error; client should close the call

const { Server } = require('socket.io');
const { verifyToken } = require('../utils/jwt');
const Visit = require('../models/Visit');
const User = require('../models/User');
const Notification = require('../models/Notification');

const ROOM_PREFIX = 'visit:';
const USER_ROOM = userId => `user:${userId}`;

const attachSignaling = httpServer => {
  // Reuse a single Server instance across namespaces (visit-call + chat)
  // so we don't double-bind the websocket upgrade handler on the same
  // HTTP server. The first attach-er creates it; subsequent ones reuse.
  let io = httpServer._io;
  if (!io) {
    io = new Server(httpServer, {
      cors: { origin: '*' },
      // Long polling fallback is important for clients on flaky mobile data
      // where the websocket upgrade can't complete. Render's free tier
      // supports both transports.
      transports: ['websocket', 'polling'],
      // The default ping timeouts are tuned for browsers; tighten for
      // mobile so a backgrounded app or dead connection is detected
      // quickly.
      pingInterval: 20000,
      pingTimeout: 25000,
    });
    httpServer._io = io;
  }

  const ns = io.of('/visit-call');

  ns.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Missing auth token'));
      const payload = verifyToken(token);
      const userId = payload.sub || payload.id || payload._id;
      if (!userId) return next(new Error('Invalid token payload'));
      socket.data.userId = String(userId);
      next();
    } catch (e) {
      next(new Error('Unauthorized'));
    }
  });

  ns.on('connection', socket => {
    const userId = socket.data.userId;

    // Every authenticated socket joins its own user room so we can target
    // it directly for ring events without tracking a userId→socketId map.
    socket.join(USER_ROOM(userId));

    // Caller-side cancel: the joiner can tell us they're abandoning the
    // attempt before the peer picks up. We forward to the peer so they can
    // dismiss the incoming-call overlay.
    socket.on('cancel-call', async ({ visitId } = {}) => {
      if (!visitId) return;
      try {
        const visit = await Visit.findById(visitId).select('consumerId propertyOwnerId');
        if (!visit) return;
        const buyerId = String(visit.consumerId || '');
        const ownerId = String(visit.propertyOwnerId || '');
        const otherUserId = userId === buyerId ? ownerId : userId === ownerId ? buyerId : null;
        if (otherUserId) {
          ns.to(USER_ROOM(otherUserId)).emit('incoming-call-cancelled', { visitId });
        }
      } catch {}
    });

    // Callee-side decline: tell the caller the other party rejected.
    socket.on('decline-call', async ({ visitId } = {}) => {
      if (!visitId) return;
      try {
        const visit = await Visit.findById(visitId).select('consumerId propertyOwnerId');
        if (!visit) return;
        const buyerId = String(visit.consumerId || '');
        const ownerId = String(visit.propertyOwnerId || '');
        const otherUserId = userId === buyerId ? ownerId : userId === ownerId ? buyerId : null;
        if (otherUserId) {
          ns.to(USER_ROOM(otherUserId)).emit('call-declined', { visitId });
        }
      } catch {}
    });

    socket.on('join', async ({ visitId } = {}, ack) => {
      if (!visitId || typeof visitId !== 'string') {
        ack?.({ ok: false, error: 'visitId required' });
        socket.emit('error', { message: 'visitId required' });
        return;
      }

      let visit;
      try {
        visit = await Visit.findById(visitId).select(
          'consumerId propertyOwnerId mode status propertyTitle',
        );
      } catch {
        ack?.({ ok: false, error: 'invalid visit' });
        socket.emit('error', { message: 'Invalid visit' });
        return;
      }

      if (!visit) {
        ack?.({ ok: false, error: 'visit not found' });
        socket.emit('error', { message: 'Visit not found' });
        return;
      }

      const buyerId = String(visit.consumerId || '');
      const ownerId = String(visit.propertyOwnerId || '');
      if (userId !== buyerId && userId !== ownerId) {
        ack?.({ ok: false, error: 'forbidden' });
        socket.emit('error', { message: 'You are not part of this visit' });
        return;
      }

      const role = userId === buyerId ? 'buyer' : 'seller';
      socket.data.role = role;
      socket.data.visitId = visitId;

      const roomName = ROOM_PREFIX + visitId;
      const existing = await ns.in(roomName).fetchSockets();
      const peers = existing.map(s => ({ socketId: s.id, role: s.data?.role }));

      socket.join(roomName);

      // Tell the joiner who's already there so it can initiate offers.
      ack?.({ ok: true, self: socket.id, peers, role });
      socket.to(roomName).emit('peer-joined', { socketId: socket.id, role });

      // If we were the first one in the room, ring the other party so they
      // know a call is waiting. We target their user room (joined on
      // socket connect), so any of their open clients picks up the event.
      // We also create a persistent Notification as a fallback for clients
      // that aren't online right now.
      if (peers.length === 0) {
        const otherUserId = userId === buyerId ? ownerId : buyerId;
        if (otherUserId) {
          let callerName = 'Someone';
          try {
            const me = await User.findById(userId).select('fullName');
            if (me?.fullName) callerName = me.fullName;
          } catch {}

          ns.to(USER_ROOM(otherUserId)).emit('incoming-call', {
            visitId,
            callerName,
            callerRole: role,
            propertyTitle: visit.propertyTitle ?? undefined,
          });

          Notification.create({
            userId: otherUserId,
            type: 'visit_reminder',
            title: 'Incoming virtual tour',
            body: `${callerName} is waiting on the virtual tour for your visit. Tap to join.`,
            actionId: visitId,
          }).catch(() => {});
        }
      }
    });

    // Generic relay — `to` is a peer's socket id. We never inspect the
    // payload contents, just forward.
    socket.on('signal', ({ to, data } = {}) => {
      if (!to || !data) return;
      ns.to(to).emit('signal', { from: socket.id, data });
    });

    const leaveCurrentRoom = () => {
      const visitId = socket.data.visitId;
      if (!visitId) return;
      const roomName = ROOM_PREFIX + visitId;
      socket.to(roomName).emit('peer-left', { socketId: socket.id });
      socket.leave(roomName);
      socket.data.visitId = null;
    };

    socket.on('leave', leaveCurrentRoom);
    socket.on('disconnecting', leaveCurrentRoom);
  });

  return io;
};

module.exports = { attachSignaling };
