const Property = require('../models/Property');
const Lead = require('../models/Lead');
const { ok, created, ApiError } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');

// ===== LISTINGS =====
exports.myListings = asyncHandler(async (req, res) => {
  const items = await Property.find({ ownerId: req.user._id, isUserListing: true }).sort({ updatedAt: -1 });
  ok(res, items.map(i => i.toPublic()));
});

exports.listingDetail = asyncHandler(async (req, res) => {
  const item = await Property.findOne({ _id: req.params.id, ownerId: req.user._id });
  if (!item) throw new ApiError(404, 'Listing not found');
  ok(res, item.toPublic());
});

exports.createListing = asyncHandler(async (req, res) => {
  const seller = req.user.seller || {};
  if (seller.listingQuotaUsed >= seller.listingQuotaTotal) {
    throw new ApiError(402, 'Listing quota exceeded — upgrade your plan');
  }
  const draft = req.body;
  const item = await Property.create({
    ...draft,
    ownerId: req.user._id,
    isUserListing: true,
    builder: req.user.fullName,
    builderInfo: { name: req.user.fullName, established: 0, projectsCompleted: 0, rating: 0 },
    status: 'live',
    pricePerSqft:
      draft.pricePerSqft ||
      (draft.areaMin > 0 ? Math.round(draft.priceMin / draft.areaMin) : 0),
    priceMax: draft.priceMax || draft.priceMin,
    areaMax: draft.areaMax || draft.areaMin,
  });

  // bump quota
  req.user.seller.listingQuotaUsed = (req.user.seller.listingQuotaUsed || 0) + 1;
  await req.user.save();

  created(res, item.toPublic());
});

exports.updateListing = asyncHandler(async (req, res) => {
  const item = await Property.findOneAndUpdate(
    { _id: req.params.id, ownerId: req.user._id },
    { $set: req.body },
    { new: true },
  );
  if (!item) throw new ApiError(404, 'Listing not found');
  ok(res, item.toPublic());
});

exports.setStatus = asyncHandler(async (req, res) => {
  const status = req.body.status;
  if (!['draft', 'live', 'paused', 'sold', 'review'].includes(status)) {
    throw new ApiError(400, 'Invalid status');
  }
  const item = await Property.findOneAndUpdate(
    { _id: req.params.id, ownerId: req.user._id },
    { status },
    { new: true },
  );
  if (!item) throw new ApiError(404, 'Listing not found');
  ok(res, item.toPublic());
});

exports.deleteListing = asyncHandler(async (req, res) => {
  const item = await Property.findOneAndDelete({ _id: req.params.id, ownerId: req.user._id });
  if (!item) throw new ApiError(404, 'Listing not found');
  if (req.user.seller && req.user.seller.listingQuotaUsed > 0) {
    req.user.seller.listingQuotaUsed -= 1;
    await req.user.save();
  }
  ok(res, { success: true });
});

// ===== LEADS =====
exports.leads = asyncHandler(async (req, res) => {
  const items = await Lead.find({ sellerId: req.user._id }).sort({ createdAt: -1 });
  ok(res, items.map(l => l.toPublic()));
});

exports.setLeadStatus = asyncHandler(async (req, res) => {
  const status = req.body.status;
  if (!['new', 'contacted', 'visit_booked', 'closed_won', 'closed_lost'].includes(status)) {
    throw new ApiError(400, 'Invalid status');
  }
  const lead = await Lead.findOneAndUpdate(
    { _id: req.params.id, sellerId: req.user._id },
    { status },
    { new: true },
  );
  if (!lead) throw new ApiError(404, 'Lead not found');
  ok(res, lead.toPublic());
});

// ===== ANALYTICS =====
exports.analytics = asyncHandler(async (req, res) => {
  const items = await Property.find({ ownerId: req.user._id, isUserListing: true });
  const totalViews = items.reduce((s, l) => s + (l.views || 0), 0);
  const totalInquiries = items.reduce((s, l) => s + (l.inquiriesCount || 0), 0);
  const totalCallbacks = items.reduce((s, l) => s + (l.callbackRequests || 0), 0);
  const totalSaves = items.reduce((s, l) => s + (l.saves || 0), 0);
  const conversionRate = totalViews > 0 ? Math.round((totalInquiries / totalViews) * 1000) / 10 : 0;

  // Mock weekly distribution for now (replace with real time-series later)
  const weeklyViews = Array.from({ length: 7 }, () => Math.floor(Math.random() * 220) + 60);

  const topListings = items
    .filter(l => l.status === 'live')
    .sort((a, b) => (b.views || 0) - (a.views || 0))
    .slice(0, 5)
    .map(l => ({
      id: String(l._id),
      title: l.title,
      views: l.views || 0,
      inquiries: l.inquiriesCount || 0,
    }));

  ok(res, { totalViews, totalInquiries, totalCallbacks, totalSaves, conversionRate, weeklyViews, topListings });
});
