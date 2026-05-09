const Property = require('../models/Property');
const { ok, ApiError } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildFilter(q) {
  const filter = { status: { $ne: 'draft' } };
  if (q.city) {
    // Case-insensitive exact-ish match — Nominatim sometimes returns city
    // names with slightly different casing than the seed data.
    filter.city = new RegExp(`^${escapeRegex(String(q.city))}$`, 'i');
  }
  if (q.locality) {
    // Localities are matched as substring (case-insensitive) so a Nominatim
    // result like "Powai" finds listings whose locality is "Powai East"
    // or vice versa.
    filter.locality = new RegExp(escapeRegex(String(q.locality)), 'i');
  }
  if (q.types) {
    const arr = Array.isArray(q.types) ? q.types : String(q.types).split(',');
    filter.type = { $in: arr };
  }
  if (q.bhk) {
    const arr = Array.isArray(q.bhk) ? q.bhk : String(q.bhk).split(',');
    filter.configuration = { $in: arr };
  }
  if (q.budgetMin) filter.priceMin = { ...(filter.priceMin || {}), $gte: Number(q.budgetMin) };
  if (q.budgetMax) filter.priceMin = { ...(filter.priceMin || {}), $lte: Number(q.budgetMax) };
  if (q.possessionStatus) {
    const arr = Array.isArray(q.possessionStatus)
      ? q.possessionStatus
      : String(q.possessionStatus).split(',');
    filter.possessionStatus = { $in: arr };
  }
  if (q.amenities) {
    const arr = Array.isArray(q.amenities) ? q.amenities : String(q.amenities).split(',');
    filter['amenities.id'] = { $all: arr };
  }
  if (q.search) {
    filter.$text = { $search: q.search };
  }
  return filter;
}

exports.list = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, parseInt(req.query.pageSize, 10) || 10);
  const filter = buildFilter(req.query);
  const [items, total] = await Promise.all([
    Property.find(filter)
      .sort({ featured: -1, rating: -1, createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
    Property.countDocuments(filter),
  ]);
  ok(res, {
    items: items.map(i => i.toPublic()),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  });
});

exports.detail = asyncHandler(async (req, res) => {
  const p = await Property.findById(req.params.id);
  if (!p) throw new ApiError(404, 'Property not found');
  // increment view counter (fire-and-forget)
  Property.updateOne({ _id: p._id }, { $inc: { views: 1 } }).catch(() => {});
  ok(res, p.toPublic());
});

exports.featured = asyncHandler(async (_req, res) => {
  const items = await Property.find({ featured: true, status: { $ne: 'draft' } })
    .sort({ rating: -1 })
    .limit(8);
  ok(res, items.map(i => i.toPublic()));
});

exports.trending = asyncHandler(async (_req, res) => {
  const items = await Property.find({ trending: true, status: { $ne: 'draft' } })
    .sort({ views: -1 })
    .limit(8);
  ok(res, items.map(i => i.toPublic()));
});

exports.recommended = asyncHandler(async (_req, res) => {
  const items = await Property.find({ status: { $ne: 'draft' } })
    .sort({ rating: -1 })
    .limit(8);
  ok(res, items.map(i => i.toPublic()));
});

exports.similar = asyncHandler(async (req, res) => {
  const p = await Property.findById(req.params.id);
  if (!p) throw new ApiError(404, 'Property not found');
  const items = await Property.find({
    _id: { $ne: p._id },
    status: { $ne: 'draft' },
    $or: [{ city: p.city }, { type: p.type }],
  }).limit(6);
  ok(res, items.map(i => i.toPublic()));
});

exports.search = asyncHandler(async (req, res) => {
  const q = req.query.q || '';
  if (!q) return ok(res, []);
  const items = await Property.find({ $text: { $search: String(q) }, status: { $ne: 'draft' } }).limit(20);
  ok(res, items.map(i => i.toPublic()));
});

exports.savedList = asyncHandler(async (req, res) => {
  const ids = req.user.savedPropertyIds || [];
  const items = await Property.find({ _id: { $in: ids } });
  ok(res, items.map(i => i.toPublic()));
});

exports.toggleSave = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const idx = req.user.savedPropertyIds.findIndex(x => String(x) === String(id));
  if (idx === -1) {
    req.user.savedPropertyIds.push(id);
    await req.user.save();
    Property.updateOne({ _id: id }, { $inc: { saves: 1 } }).catch(() => {});
    ok(res, { saved: true });
  } else {
    req.user.savedPropertyIds.splice(idx, 1);
    await req.user.save();
    Property.updateOne({ _id: id }, { $inc: { saves: -1 } }).catch(() => {});
    ok(res, { saved: false });
  }
});
