const Property = require('../models/Property');
const Lead = require('../models/Lead');
const Visit = require('../models/Visit');
const Notification = require('../models/Notification');
const { ok, created, ApiError } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');

// Shape a Visit for the seller-facing API: flatten the populated buyer
// (consumerId) into top-level buyer* fields so the mobile client doesn't
// need to know about the populate plumbing.
const toSellerVisit = visit => {
  const obj = visit.toObject({ virtuals: false });
  const buyer = obj.consumerId && typeof obj.consumerId === 'object' ? obj.consumerId : null;
  return {
    id: String(obj._id),
    propertyId: String(obj.propertyId),
    propertyTitle: obj.propertyTitle,
    propertyImage: obj.propertyImage,
    propertyLocation: obj.propertyLocation,
    date: obj.date,
    timeSlot: obj.timeSlot,
    mode: obj.mode,
    status: obj.status,
    notes: obj.notes,
    advisorName: obj.advisorName,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    buyer: buyer
      ? {
          id: String(buyer._id),
          fullName: buyer.fullName,
          phone: buyer.phone,
          email: buyer.email,
          avatar: buyer.avatar,
        }
      : null,
  };
};

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
// Lazy-backfill: every active visit booked on this seller's listings should
// be reflected in the Leads pipeline.
//
// Dedupe rules:
//   - If an ACTIVE Lead (new / contacted / visit_booked) already exists for
//     this listing+buyer pair, upgrade it to visit_booked instead of
//     creating a duplicate.
//   - If only a TERMINAL Lead exists (closed_won / closed_lost), the seller
//     has already closed that engagement, so the fresh visit is treated as
//     a new engagement and a brand-new Lead is created.
//   - If no Lead at all exists, create one.
//
// This protects against bookings made before the visit→lead pipeline was
// deployed and against any future gap (e.g. notification path silently
// fails). The operation is idempotent.
const formatVisitDate = date => {
  try {
    return new Date(date).toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return new Date(date).toISOString().slice(0, 10);
  }
};

const backfillLeadsFromVisits = async sellerId => {
  const visits = await Visit.find({
    propertyOwnerId: sellerId,
    status: { $in: ['upcoming', 'completed', 'rescheduled'] },
  }).populate('consumerId', 'fullName phone email avatar');

  if (!visits.length) return;

  const existing = await Lead.find({ sellerId }).select('listingId consumerId status');
  // Index by listing+buyer → array of leads, so we can distinguish "active
  // lead exists" from "only terminal leads exist".
  const byKey = new Map();
  for (const l of existing) {
    const k = `${String(l.listingId)}::${String(l.consumerId || '')}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(l);
  }
  const isActive = s => s === 'new' || s === 'contacted' || s === 'visit_booked';

  const toCreate = [];
  const toUpgrade = []; // existing leads whose status we want to bump

  for (const v of visits) {
    const buyer = v.consumerId && typeof v.consumerId === 'object' ? v.consumerId : null;
    if (!buyer) continue;
    const key = `${String(v.propertyId)}::${String(buyer._id)}`;
    const matches = byKey.get(key) ?? [];
    const activeMatch = matches.find(m => isActive(m.status));

    const modeLabel = v.mode === 'virtual' ? 'Virtual tour' : 'In-person visit';
    const message = `${modeLabel} scheduled for ${formatVisitDate(v.date)}, ${v.timeSlot}`;

    if (activeMatch) {
      if (activeMatch.status !== 'visit_booked') {
        toUpgrade.push({ id: activeMatch._id, message });
      }
      continue;
    }

    // No active lead — either no lead at all, or only terminal leads exist.
    // Create a fresh visit_booked lead either way.
    toCreate.push({
      sellerId,
      listingId: v.propertyId,
      listingTitle: v.propertyTitle,
      listingImage: v.propertyImage,
      consumerId: buyer._id,
      consumerName: buyer.fullName,
      consumerPhone: buyer.phone,
      consumerEmail: buyer.email,
      message,
      status: 'visit_booked',
    });
    // Track so a second visit on the same pair in this batch doesn't
    // create yet another duplicate within the same request.
    matches.push({ status: 'visit_booked' });
    byKey.set(key, matches);
  }

  if (toCreate.length) await Lead.insertMany(toCreate);
  for (const u of toUpgrade) {
    await Lead.updateOne({ _id: u.id }, { status: 'visit_booked', message: u.message });
  }
};

exports.leads = asyncHandler(async (req, res) => {
  await backfillLeadsFromVisits(req.user._id).catch(() => {});
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

// ===== VISITS (seller view) =====
exports.visits = asyncHandler(async (req, res) => {
  const visits = await Visit.find({ propertyOwnerId: req.user._id })
    .populate('consumerId', 'fullName phone email avatar')
    .sort({ date: 1 });
  ok(res, visits.map(toSellerVisit));
});

exports.setVisitStatus = asyncHandler(async (req, res) => {
  const status = req.body.status;
  if (!['upcoming', 'completed', 'cancelled', 'rescheduled'].includes(status)) {
    throw new ApiError(400, 'Invalid status');
  }
  const visit = await Visit.findOneAndUpdate(
    { _id: req.params.id, propertyOwnerId: req.user._id },
    { status },
    { new: true },
  ).populate('consumerId', 'fullName phone email avatar');
  if (!visit) throw new ApiError(404, 'Visit not found');

  // Tell the buyer about meaningful state changes so they're not in the dark.
  if (status === 'cancelled' || status === 'completed') {
    Notification.create({
      userId: visit.consumerId?._id || visit.consumerId,
      type: 'visit_reminder',
      title: status === 'cancelled' ? 'Visit cancelled by host' : 'Visit marked as completed',
      body:
        status === 'cancelled'
          ? `Your visit for "${visit.propertyTitle}" was cancelled by the seller.`
          : `Your visit for "${visit.propertyTitle}" has been marked completed.`,
      actionId: String(visit._id),
    }).catch(() => {});
  }

  ok(res, toSellerVisit(visit));
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
