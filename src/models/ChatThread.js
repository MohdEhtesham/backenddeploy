const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'advisor'], required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  },
  { _id: true },
);

const ChatThreadSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    advisorName: { type: String, default: 'Priya Mehta' },
    advisorTitle: { type: String, default: 'Senior Property Advisor' },
    advisorAvatar: String,
    online: { type: Boolean, default: true },
    lastActive: { type: Date, default: Date.now },
    messages: [MessageSchema],
  },
  { timestamps: true },
);

ChatThreadSchema.methods.toPublic = function () {
  const obj = this.toObject();
  obj.id = String(obj._id);
  delete obj._id;
  delete obj.__v;
  obj.messages = (obj.messages || []).map(m => ({
    id: String(m._id),
    role: m.role,
    text: m.text,
    timestamp: m.timestamp,
    status: m.status,
  }));
  return obj;
};

module.exports = mongoose.model('ChatThread', ChatThreadSchema);
