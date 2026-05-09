const mongoose = require('mongoose');

const AmenitySchema = new mongoose.Schema(
  {
    id: String,
    name: String,
    iconName: String,
  },
  { _id: false },
);

const FloorPlanSchema = new mongoose.Schema(
  {
    id: String,
    configuration: String,
    area: Number,
    price: Number,
    imageUrl: String,
  },
  { _id: false },
);

const BuilderSchema = new mongoose.Schema(
  {
    id: String,
    name: String,
    logo: String,
    established: Number,
    projectsCompleted: Number,
    rating: Number,
  },
  { _id: false },
);

const PropertySchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, index: 'text' },
    description: { type: String, default: '' },
    type: { type: String, enum: ['apartment', 'villa', 'plot', 'commercial', 'penthouse', 'studio'], required: true, index: true },
    builder: { type: String, required: true, index: 'text' },
    builderInfo: { type: BuilderSchema, default: () => ({}) },
    city: { type: String, required: true, index: true },
    locality: { type: String, required: true, index: 'text' },
    address: String,
    latitude: Number,
    longitude: Number,
    priceMin: { type: Number, required: true, index: true },
    priceMax: { type: Number, required: true },
    pricePerSqft: Number,
    configuration: [String],
    areaMin: Number,
    areaMax: Number,
    totalUnits: Number,
    totalTowers: Number,
    possessionStatus: { type: String, enum: ['Ready to Move', 'Under Construction', 'New Launch'], index: true },
    possessionDate: Date,
    reraId: String,
    images: [String],
    amenities: [AmenitySchema],
    floorPlans: [FloorPlanSchema],
    highlights: [String],
    featured: { type: Boolean, default: false, index: true },
    trending: { type: Boolean, default: false, index: true },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    // For seller-listed properties (different from curated catalog above)
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    isUserListing: { type: Boolean, default: false, index: true },
    status: {
      type: String,
      enum: ['draft', 'live', 'sold', 'paused', 'review'],
      default: 'live',
      index: true,
    },
    views: { type: Number, default: 0 },
    inquiriesCount: { type: Number, default: 0 },
    callbackRequests: { type: Number, default: 0 },
    saves: { type: Number, default: 0 },
  },
  { timestamps: true },
);

PropertySchema.methods.toPublic = function () {
  const obj = this.toObject();
  obj.id = String(obj._id);
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Property', PropertySchema);
