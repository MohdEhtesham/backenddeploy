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
//
// Architecture (single source of truth):
//   - Inquiries → real Lead documents (created in inquiry.controller).
//   - Visits   → no separate Lead document is ever written. Instead, the
//                /seller/leads endpoint synthesizes visit-derived lead rows
//                on the fly from the Visit collection.
//
// Why this beats the previous "always write a Lead row" approach:
//   1. Zero drift between Visit state and Lead state — there's only one
//      collection backing each entity.
//   2. Idempotent without writes — every GET reflects current truth.
//   3. No timing/redeploy race: even if the visit was booked before the
//      seller-side pipeline existed, it appears the next time the seller
//      opens the Leads tab.
//
// Dedup rules between real leads and visits for the same buyer+listing pair:
//   - If an ACTIVE real Lead exists (new / contacted / visit_booked), we
//     trust that — it's likely the inquiry-driven row. We do NOT also
//     synthesize a visit-derived row, to avoid showing the same buyer twice.
//   - If only TERMINAL leads exist (closed_won / closed_lost), or no lead
//     at all, a fresh visit is a new engagement and we synthesize a row.
//
// Promotion: the moment the seller acts on a visit-derived row (advances
// status / changes status), setLeadStatus promotes it to a real Lead so
// status history is preserved going forward.
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

const VISIT_LEAD_PREFIX = 'visit_';
const isActiveLeadStatus = s => s === 'new' || s === 'contacted' || s === 'visit_booked';

const synthesizeVisitLead = visit => {
  const buyer = visit.consumerId && typeof visit.consumerId === 'object' ? visit.consumerId : null;
  if (!buyer) return null;
  const modeLabel = visit.mode === 'virtual' ? 'Virtual tour' : 'In-person visit';
  return {
    id: `${VISIT_LEAD_PREFIX}${visit._id}`,
    visitId: String(visit._id),
    isVisitDerived: true,
    sellerId: String(visit.propertyOwnerId),
    listingId: String(visit.propertyId),
    listingTitle: visit.propertyTitle,
    listingImage: visit.propertyImage,
    consumerId: String(buyer._id),
    consumerName: buyer.fullName,
    consumerPhone: buyer.phone,
    consumerEmail: buyer.email,
    message: `${modeLabel} scheduled for ${formatVisitDate(visit.date)}, ${visit.timeSlot}`,
    status: 'visit_booked',
    createdAt: visit.createdAt,
    updatedAt: visit.updatedAt,
  };
};

exports.leads = asyncHandler(async (req, res) => {
  const sellerId = req.user._id;

  const [realLeads, visits] = await Promise.all([
    Lead.find({ sellerId }).sort({ createdAt: -1 }),
    Visit.find({
      propertyOwnerId: sellerId,
      status: { $in: ['upcoming', 'completed', 'rescheduled'] },
    })
      .populate('consumerId', 'fullName phone email avatar')
      .sort({ createdAt: -1 }),
  ]);

  // Index real leads by listing+buyer → array, so we can answer "is there
  // already an active lead for this pair?" without looping per-visit.
  const realByKey = new Map();
  for (const l of realLeads) {
    const k = `${String(l.listingId)}::${String(l.consumerId || '')}`;
    if (!realByKey.has(k)) realByKey.set(k, []);
    realByKey.get(k).push(l);
  }

  // Also key existing visit promotions: a real lead may already encode a
  // visit (after promotion via setLeadStatus). We dedupe via visitId.
  const promotedVisitIds = new Set(
    realLeads.filter(l => l.visitId).map(l => String(l.visitId)),
  );

  const synthesized = [];
  for (const v of visits) {
    if (promotedVisitIds.has(String(v._id))) continue;
    const buyer = v.consumerId && typeof v.consumerId === 'object' ? v.consumerId : null;
    if (!buyer) continue;
    const k = `${String(v.propertyId)}::${String(buyer._id)}`;
    const matches = realByKey.get(k) ?? [];
    const hasActive = matches.some(m => isActiveLeadStatus(m.status));
    if (hasActive) continue; // surface the existing real lead instead
    const synth = synthesizeVisitLead(v);
    if (synth) synthesized.push(synth);
  }

  const merged = [
    ...realLeads.map(l => l.toPublic()),
    ...synthesized,
  ].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

  ok(res, merged);
});

exports.setLeadStatus = asyncHandler(async (req, res) => {
  const status = req.body.status;
  if (!['new', 'contacted', 'visit_booked', 'closed_won', 'closed_lost'].includes(status)) {
    throw new ApiError(400, 'Invalid status');
  }

  const id = req.params.id;

  // Visit-derived synthetic id → promote to a real Lead so the change
  // sticks. The Visit document keeps its own status separately (managed
  // via /seller/visits/:id/status).
  if (typeof id === 'string' && id.startsWith(VISIT_LEAD_PREFIX)) {
    const visitId = id.slice(VISIT_LEAD_PREFIX.length);
    const visit = await Visit.findOne({ _id: visitId, propertyOwnerId: req.user._id })
      .populate('consumerId', 'fullName phone email avatar');
    if (!visit) throw new ApiError(404, 'Visit not found');

    const buyer = visit.consumerId && typeof visit.consumerId === 'object' ? visit.consumerId : null;
    const modeLabel = visit.mode === 'virtual' ? 'Virtual tour' : 'In-person visit';

    const lead = await Lead.create({
      sellerId: req.user._id,
      listingId: visit.propertyId,
      listingTitle: visit.propertyTitle,
      listingImage: visit.propertyImage,
      consumerId: buyer?._id,
      consumerName: buyer?.fullName,
      consumerPhone: buyer?.phone,
      consumerEmail: buyer?.email,
      message: `${modeLabel} scheduled for ${formatVisitDate(visit.date)}, ${visit.timeSlot}`,
      status,
      visitId: visit._id,
    });
    ok(res, lead.toPublic());
    return;
  }

  const lead = await Lead.findOneAndUpdate(
    { _id: id, sellerId: req.user._id },
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
