const Visit = require('../models/Visit');
const Property = require('../models/Property');
const Notification = require('../models/Notification');
const Lead = require('../models/Lead');
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

  // For seller-listed properties also notify the owner and create/update a
  // Lead so the booking shows up in their Leads tab with the right status.
  if (property.ownerId && property.isUserListing) {
    const dateLabel = formatVisitDate(visit.date);
    const modeLabel = visit.mode === 'virtual' ? 'Virtual tour' : 'In-person visit';
    const visitMessage = `${modeLabel} scheduled for ${dateLabel}, ${visit.timeSlot}`;

    // If we already have a lead from an earlier inquiry by the same buyer,
    // update its status to visit_booked rather than duplicating.
    const existing = await Lead.findOne({
      sellerId: property.ownerId,
      listingId: property._id,
      consumerId: req.user._id,
    });

    if (existing) {
      existing.status = 'visit_booked';
      existing.message = visitMessage;
      await existing.save();
    } else {
      await Lead.create({
        sellerId: property.ownerId,
        listingId: property._id,
        listingTitle: property.title,
        listingImage: property.images?.[0],
        consumerId: req.user._id,
        consumerName: req.user.fullName,
        consumerPhone: req.user.phone,
        consumerEmail: req.user.email,
        message: visitMessage,
        status: 'visit_booked',
      });
    }

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
