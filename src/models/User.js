const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const PreferencesSchema = new mongoose.Schema(
  {
    budgetMin: { type: Number, default: 0 },
    budgetMax: { type: Number, default: 0 },
    preferredCities: [String],
    preferredTypes: [String],
    preferredConfigs: [String],
    notificationsEnabled: { type: Boolean, default: true },
  },
  { _id: false },
);

const SellerProfileSchema = new mongoose.Schema(
  {
    companyName: String,
    reraId: String,
    plan: { type: String, enum: ['free', 'basic', 'pro'], default: 'free' },
    planExpiresAt: Date,
    listingQuotaUsed: { type: Number, default: 0 },
    listingQuotaTotal: { type: Number, default: 1 },
    totalLeads: { type: Number, default: 0 },
    rating: { type: Number, default: 0 },
  },
  { _id: false },
);

const UserSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    phone: { type: String, required: true, trim: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    avatar: String,
    city: String,
    role: { type: String, enum: ['consumer', 'seller'], default: 'consumer', index: true },
    preferences: { type: PreferencesSchema, default: () => ({}) },
    seller: { type: SellerProfileSchema, default: () => ({}) },
    savedPropertyIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Property' }],
  },
  { timestamps: true },
);

UserSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(plain, 10);
};

UserSchema.methods.checkPassword = async function (plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

UserSchema.methods.toPublic = function () {
  const obj = this.toObject({ virtuals: true });
  delete obj.passwordHash;
  delete obj.__v;
  obj.id = String(obj._id);
  delete obj._id;
  return obj;
};

module.exports = mongoose.model('User', UserSchema);
