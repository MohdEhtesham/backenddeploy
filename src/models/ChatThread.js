const mongoose = require('mongoose');

// A 1:1 chat thread between a buyer and a seller for a specific listing.
//
// Uniqueness is enforced via a compound (listingId, buyerId, sellerId) index
// so calling /chat/threads with the same trio is idempotent — useful for
// "Open chat with seller" buttons that may fire repeatedly.
const ChatThreadSchema = new mongoose.Schema(
  {
    listingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: true,
      index: true,
    },
    /** Denormalised so list views don't need to populate a Property. */
    listingTitle: String,
    listingImage: String,

    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Last message preview shown on the thread list. */
    lastMessage: String,
    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastSenderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    /** Per-side unread counters maintained by the chat controller / socket. */
    buyerUnread: { type: Number, default: 0 },
    sellerUnread: { type: Number, default: 0 },
  },
  { timestamps: true },
);

ChatThreadSchema.index(
  { listingId: 1, buyerId: 1, sellerId: 1 },
  { unique: true },
);

ChatThreadSchema.methods.toPublic = function () {
  const obj = this.toObject();
  return {
    id: String(obj._id),
    listingId: String(obj.listingId),
    listingTitle: obj.listingTitle,
    listingImage: obj.listingImage,
    buyerId: String(obj.buyerId),
    sellerId: String(obj.sellerId),
    lastMessage: obj.lastMessage,
    lastMessageAt: obj.lastMessageAt,
    lastSenderId: obj.lastSenderId ? String(obj.lastSenderId) : null,
    buyerUnread: obj.buyerUnread,
    sellerUnread: obj.sellerUnread,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
};

module.exports = mongoose.model('ChatThread', ChatThreadSchema);
