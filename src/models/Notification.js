const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['inquiry_update', 'visit_reminder', 'new_property', 'price_drop', 'message', 'system'],
      required: true,
    },
    title: String,
    body: String,
    read: { type: Boolean, default: false, index: true },
    actionId: String,
    imageUrl: String,
  },
  { timestamps: true },
);

NotificationSchema.methods.toPublic = function () {
  const obj = this.toObject();
  obj.id = String(obj._id);
  delete obj._id;
  delete obj.__v;
  obj.createdAt = obj.createdAt;
  return obj;
};

module.exports = mongoose.model('Notification', NotificationSchema);
