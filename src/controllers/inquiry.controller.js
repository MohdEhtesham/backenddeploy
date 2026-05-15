const Inquiry = require('../models/Inquiry');
const Property = require('../models/Property');
const Lead = require('../models/Lead');
const Notification = require('../models/Notification');
const ChatThread = require('../models/ChatThread');
const { ok, created, ApiError } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');

exports.list = asyncHandler(async (req, res) => {
  const inquiries = await Inquiry.find({ consumerId: req.user._id }).sort({ updatedAt: -1 });
  ok(res, inquiries.map(i => i.toPublic()));
});

exports.detail = asyncHandler(async (req, res) => {
  const i = await Inquiry.findOne({ _id: req.params.id, consumerId: req.user._id });
  if (!i) throw new ApiError(404, 'Inquiry not found');
  ok(res, i.toPublic());
});

exports.create = asyncHandler(async (req, res) => {
  const { propertyId, fullName, email, phone, message } = req.body;
  const property = await Property.findById(propertyId);
  if (!property) throw new ApiError(404, 'Property not found');

  const now = new Date();
  const inquiry = await Inquiry.create({
    consumerId: req.user._id,
    propertyId: property._id,
    propertyOwnerId: property.ownerId,
    propertyTitle: property.title,
    propertyImage: property.images?.[0],
    propertyLocation: `${property.locality}, ${property.city}`,
    fullName,
    email,
    phone,
    message,
    status: 'new',
    events: [
      {
        id: 'e1',
        status: 'new',
        title: 'Inquiry submitted',
        description: 'Your inquiry has been received',
        timestamp: now,
      },
    ],
  });

  // increment property counter
  Property.updateOne({ _id: property._id }, { $inc: { inquiriesCount: 1 } }).catch(() => {});

  // Idempotently open a chat thread between buyer + seller for this listing
  // (find-or-create via the compound unique index). Buyer can tap "Open
  // chat" on the success screen and immediately land in a live thread.
  if (property.ownerId && String(req.user._id) !== String(property.ownerId)) {
    ChatThread.findOneAndUpdate(
      { listingId: property._id, buyerId: req.user._id, sellerId: property.ownerId },
      {
        $setOnInsert: {
          listingId: property._id,
          listingTitle: property.title,
          listingImage: property.images?.[0],
          buyerId: req.user._id,
          sellerId: property.ownerId,
          lastMessageAt: new Date(),
        },
      },
      { new: true, upsert: true },
    ).catch(() => {});
  }

  // For seller-listed properties, also create a Lead for the owner
  if (property.ownerId && property.isUserListing) {
    await Lead.create({
      sellerId: property.ownerId,
      listingId: property._id,
      listingTitle: property.title,
      listingImage: property.images?.[0],
      consumerId: req.user._id,
      consumerName: fullName,
      consumerPhone: phone,
      consumerEmail: email,
      message,
      status: 'new',
    });

    // notify the seller
    await Notification.create({
      userId: property.ownerId,
      type: 'message',
      title: 'New lead received',
      body: `${fullName} inquired on "${property.title}"`,
      actionId: String(inquiry._id),
    });
  }

  // notify the consumer
  await Notification.create({
    userId: req.user._id,
    type: 'inquiry_update',
    title: 'Inquiry submitted',
    body: 'A property advisor will reach out to you soon.',
    actionId: String(inquiry._id),
  });

  created(res, inquiry.toPublic());
});
