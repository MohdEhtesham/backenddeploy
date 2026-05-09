const Visit = require('../models/Visit');
const Property = require('../models/Property');
const Notification = require('../models/Notification');
const { ok, created, ApiError } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');

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

const SLOTS = [
  '10:00 AM - 11:00 AM',
  '11:00 AM - 12:00 PM',
  '12:00 PM - 1:00 PM',
  '2:00 PM - 3:00 PM',
  '3:00 PM - 4:00 PM',
  '4:00 PM - 5:00 PM',
  '5:00 PM - 6:00 PM',
];

exports.list = asyncHandler(async (req, res) => {
  const visits = await Visit.find({ consumerId: req.user._id }).sort({ date: -1 });
  ok(res, visits.map(v => v.toPublic()));
});

exports.detail = asyncHandler(async (req, res) => {
  const v = await Visit.findOne({ _id: req.params.id, consumerId: req.user._id });
  if (!v) throw new ApiError(404, 'Visit not found');
  ok(res, v.toPublic());
});

exports.slots = asyncHandler(async (_req, res) => ok(res, SLOTS));

exports.create = asyncHandler(async (req, res) => {
  const { propertyId, date, timeSlot, mode = 'in_person', notes } = req.body;
  const property = await Property.findById(propertyId);
  if (!property) throw new ApiError(404, 'Property not found');

  const visit = await Visit.create({
    consumerId: req.user._id,
    propertyId: property._id,
    propertyOwnerId: property.ownerId,
    propertyTitle: property.title,
    propertyImage: property.images?.[0],
    propertyLocation: `${property.locality}, ${property.city}`,
    date: new Date(date),
    timeSlot,
    mode,
    notes,
    advisorName: 'Priya Mehta',
    status: 'upcoming',
  });

  await Notification.create({
    userId: req.user._id,
    type: 'visit_reminder',
    title: 'Site visit booked',
    body: `Your visit to ${property.title} is confirmed`,
    actionId: String(visit._id),
  });

  // For owner-bearing properties, notify the seller. We do NOT write a
  // separate Lead row here — the /seller/leads endpoint synthesizes a
  // visit-derived lead from the Visit document at read-time, so there's a
  // single source of truth and no risk of drift.
  if (property.ownerId) {
    const dateLabel = formatVisitDate(visit.date);
    await Notification.create({
      userId: property.ownerId,
      type: 'visit_reminder',
      title: 'New site visit booked',
      body: `${req.user.fullName} booked a ${visit.mode === 'virtual' ? 'virtual tour' : 'visit'} for "${property.title}" on ${dateLabel}, ${visit.timeSlot}.`,
      actionId: String(visit._id),
    });
  }

  created(res, visit.toPublic());
});

exports.cancel = asyncHandler(async (req, res) => {
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, consumerId: req.user._id },
    { status: 'cancelled' },
    { new: true },
  );
  if (!v) throw new ApiError(404, 'Visit not found');
  ok(res, v.toPublic());
});

exports.reschedule = asyncHandler(async (req, res) => {
  const { date, timeSlot } = req.body;
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, consumerId: req.user._id },
    { date: new Date(date), timeSlot, status: 'rescheduled' },
    { new: true },
  );
  if (!v) throw new ApiError(404, 'Visit not found');
  ok(res, v.toPublic());
});
