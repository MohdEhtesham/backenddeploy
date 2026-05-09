const mongoose = require('mongoose');

const VisitSchema = new mongoose.Schema(
  {
    consumerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
    propertyOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    propertyTitle: String,
    propertyImage: String,
    propertyLocation: String,
    date: { type: Date, required: true, index: true },
    timeSlot: String,
    status: {
      type: String,
      enum: ['upcoming', 'completed', 'cancelled', 'rescheduled'],
      default: 'upcoming',
      index: true,
    },
    mode: { type: String, enum: ['in_person', 'virtual'], default: 'in_person' },
    advisorName: String,
    notes: String,
  },
  { timestamps: true },
);

VisitSchema.methods.toPublic = function () {
  const obj = this.toObject();
  obj.id = String(obj._id);
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Visit', VisitSchema);
