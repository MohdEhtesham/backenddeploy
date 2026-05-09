const mongoose = require('mongoose');

const EventSchema = new mongoose.Schema(
  {
    id: String,
    status: String,
    title: String,
    description: String,
    timestamp: Date,
  },
  { _id: false },
);

const InquirySchema = new mongoose.Schema(
  {
    consumerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
    propertyOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    propertyTitle: String,
    propertyImage: String,
    propertyLocation: String,
    fullName: String,
    email: String,
    phone: String,
    message: String,
    status: {
      type: String,
      enum: ['new', 'contacted', 'in_progress', 'visit_scheduled', 'closed'],
      default: 'new',
      index: true,
    },
    advisorName: String,
    events: [EventSchema],
  },
  { timestamps: true },
);

InquirySchema.methods.toPublic = function () {
  const obj = this.toObject();
  obj.id = String(obj._id);
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Inquiry', InquirySchema);
