const mongoose = require('mongoose');

// A single message inside a chat thread.
//
// Stored as its own collection (not embedded inside ChatThread) so:
//   - thread documents stay small as conversations grow
//   - we can paginate messages efficiently with a single index
//   - read-receipts can be updated without touching the parent doc
const MessageSchema = new mongoose.Schema(
  {
    threadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChatThread',
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: { type: String, enum: ['text', 'image'], default: 'text' },
    text: String,
    imageUrl: String,
    // Per-message read tracking — the recipient ids that have read this
    // message. Used to render WhatsApp-style single/double ticks in
    // Chunk B; for Chunk A we just append on read-all.
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true },
);

// Compound index for the common "latest messages in thread" paginated query.
MessageSchema.index({ threadId: 1, createdAt: -1 });

MessageSchema.methods.toPublic = function () {
  const obj = this.toObject();
  return {
    id: String(obj._id),
    threadId: String(obj.threadId),
    senderId: String(obj.senderId),
    type: obj.type,
    text: obj.text,
    imageUrl: obj.imageUrl,
    readBy: (obj.readBy || []).map(String),
    createdAt: obj.createdAt,
  };
};

module.exports = mongoose.model('Message', MessageSchema);
