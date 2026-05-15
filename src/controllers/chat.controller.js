const ChatThread = require('../models/ChatThread');
const Message = require('../models/Message');
const Property = require('../models/Property');
const Notification = require('../models/Notification');
const { broadcastMessage } = require('../sockets/chat');
const { ok, created, ApiError } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');

// Helper: returns the other party's id given a thread + the current user.
const otherSideId = (thread, userId) => {
  const buyer = String(thread.buyerId._id ?? thread.buyerId);
  const seller = String(thread.sellerId._id ?? thread.sellerId);
  const me = String(userId);
  if (me === buyer) return seller;
  if (me === seller) return buyer;
  return null;
};

const ensureMember = (thread, userId) => {
  const me = String(userId);
  const buyer = String(thread.buyerId._id ?? thread.buyerId);
  const seller = String(thread.sellerId._id ?? thread.sellerId);
  if (me !== buyer && me !== seller) {
    throw new ApiError(403, "You aren't part of this conversation");
  }
};

// =============================================================================
// THREADS
// =============================================================================

// GET /chat/threads → every thread the current user is part of, newest first.
exports.listThreads = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const threads = await ChatThread.find({
    $or: [{ buyerId: userId }, { sellerId: userId }],
  })
    .sort({ lastMessageAt: -1 })
    .populate('buyerId', 'fullName avatar phone')
    .populate('sellerId', 'fullName avatar phone')
    .limit(200);

  const myId = String(userId);
  const items = threads.map(t => {
    const obj = t.toPublic();
    const buyerId = String(t.buyerId._id ?? t.buyerId);
    const peer = myId === buyerId ? t.sellerId : t.buyerId;
    obj.peer =
      peer && typeof peer === 'object'
        ? {
            id: String(peer._id),
            fullName: peer.fullName,
            avatar: peer.avatar,
            phone: peer.phone,
          }
        : null;
    obj.unread = myId === buyerId ? t.buyerUnread : t.sellerUnread;
    return obj;
  });

  ok(res, items);
});

// POST /chat/threads — find-or-create a thread for a (listing, buyer, seller)
// triple. The caller's role is inferred from whether they own the listing:
//
//   - Buyer flow:  body { listingId }
//     → buyer = caller, seller = listing.ownerId
//
//   - Seller flow: body { listingId, buyerId }
//     → buyer = supplied buyerId, seller = caller (must own listing)
//
// Compound unique index on (listingId, buyerId, sellerId) makes the upsert
// race-safe, so repeated taps on "Chat" are idempotent.
exports.openThread = asyncHandler(async (req, res) => {
  const { listingId, buyerId: bodyBuyerId } = req.body;
  if (!listingId) throw new ApiError(400, 'listingId required');

  const property = await Property.findById(listingId);
  if (!property) throw new ApiError(404, 'Listing not found');
  if (!property.ownerId) throw new ApiError(400, 'This listing has no seller to chat with');

  const callerId = String(req.user._id);
  const ownerId = String(property.ownerId);
  let buyerId;
  let sellerId;

  if (callerId === ownerId) {
    // Seller flow — must supply buyerId.
    if (!bodyBuyerId) throw new ApiError(400, 'buyerId required when opening as the seller');
    if (String(bodyBuyerId) === ownerId) {
      throw new ApiError(400, "You can't open a chat with yourself");
    }
    buyerId = bodyBuyerId;
    sellerId = req.user._id;
  } else {
    // Buyer flow.
    buyerId = req.user._id;
    sellerId = property.ownerId;
  }

  const thread = await ChatThread.findOneAndUpdate(
    { listingId: property._id, buyerId, sellerId },
    {
      $setOnInsert: {
        listingId: property._id,
        listingTitle: property.title,
        listingImage: property.images?.[0],
        buyerId,
        sellerId,
        lastMessageAt: new Date(),
      },
    },
    { new: true, upsert: true },
  );

  created(res, thread.toPublic());
});

// GET /chat/threads/:id → metadata + a page of messages (newest 50 by default).
exports.getThread = asyncHandler(async (req, res) => {
  const thread = await ChatThread.findById(req.params.id)
    .populate('buyerId', 'fullName avatar phone')
    .populate('sellerId', 'fullName avatar phone');
  if (!thread) throw new ApiError(404, 'Thread not found');
  ensureMember(thread, req.user._id);

  const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
  const before = req.query.before ? new Date(req.query.before) : null;
  const filter = { threadId: thread._id };
  if (before) filter.createdAt = { $lt: before };

  const messages = await Message.find(filter).sort({ createdAt: -1 }).limit(limit);

  const myId = String(req.user._id);
  const buyerId = String(thread.buyerId._id);
  const peer = myId === buyerId ? thread.sellerId : thread.buyerId;

  ok(res, {
    thread: {
      ...thread.toPublic(),
      peer: peer
        ? {
            id: String(peer._id),
            fullName: peer.fullName,
            avatar: peer.avatar,
            phone: peer.phone,
          }
        : null,
    },
    messages: messages.reverse().map(m => m.toPublic()),
    hasMore: messages.length === limit,
  });
});

// POST /chat/threads/:id/messages — send a text or image message.
exports.sendMessage = asyncHandler(async (req, res) => {
  const thread = await ChatThread.findById(req.params.id);
  if (!thread) throw new ApiError(404, 'Thread not found');
  ensureMember(thread, req.user._id);

  const { type = 'text', text, imageUrl } = req.body;
  if (type === 'text' && (!text || !text.trim())) {
    throw new ApiError(400, 'Message text cannot be empty');
  }
  if (type === 'image' && !imageUrl) {
    throw new ApiError(400, 'imageUrl required for image messages');
  }

  const msg = await Message.create({
    threadId: thread._id,
    senderId: req.user._id,
    type,
    text: type === 'text' ? text.trim() : undefined,
    imageUrl: type === 'image' ? imageUrl : undefined,
  });

  const preview = type === 'text' ? msg.text.slice(0, 200) : '📷 Photo';
  const isFromBuyer = String(req.user._id) === String(thread.buyerId);
  await ChatThread.updateOne(
    { _id: thread._id },
    {
      $set: {
        lastMessage: preview,
        lastMessageAt: msg.createdAt,
        lastSenderId: req.user._id,
      },
      $inc: isFromBuyer ? { sellerUnread: 1 } : { buyerUnread: 1 },
    },
  );

  // Persistent fallback notification for offline recipients.
  const recipientId = otherSideId(thread, req.user._id);
  if (recipientId) {
    Notification.create({
      userId: recipientId,
      type: 'message',
      title: req.user.fullName ?? 'New message',
      body: preview,
      actionId: String(thread._id),
    }).catch(() => {});
  }

  // Fan out to the thread room + each member's user room so any open
  // client of the recipient receives it instantly.
  try {
    broadcastMessage({
      threadId: String(thread._id),
      buyerId: String(thread.buyerId),
      sellerId: String(thread.sellerId),
      message: msg.toPublic(),
    });
  } catch {}

  created(res, msg.toPublic());
});

// POST /chat/threads/:id/read — mark all incoming messages as read.
exports.markRead = asyncHandler(async (req, res) => {
  const thread = await ChatThread.findById(req.params.id);
  if (!thread) throw new ApiError(404, 'Thread not found');
  ensureMember(thread, req.user._id);

  const isBuyer = String(req.user._id) === String(thread.buyerId);
  await ChatThread.updateOne(
    { _id: thread._id },
    { $set: isBuyer ? { buyerUnread: 0 } : { sellerUnread: 0 } },
  );

  await Message.updateMany(
    { threadId: thread._id, senderId: { $ne: req.user._id } },
    { $addToSet: { readBy: req.user._id } },
  );

  ok(res, { success: true });
});
