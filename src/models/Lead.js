const mongoose = require('mongoose');

const LeadSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
    listingTitle: String,
    listingImage: String,
    consumerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    consumerName: String,
    consumerPhone: String,
    consumerEmail: String,
    message: String,
    status: {
      type: String,
      enum: ['new', 'contacted', 'visit_booked', 'closed_won', 'closed_lost'],
      default: 'new',
      index: true,
    },
  },
  { timestamps: true },
);

LeadSchema.methods.toPublic = function () {
  const obj = this.toObject();
  obj.id = String(obj._id);
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Lead', LeadSchema);
