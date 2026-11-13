const mongoose = require('mongoose');
const { createSchema, sub, userRef } = require('../../core/schema');

const MessageSchema = sub({
  authorUserId: userRef({ default: null }),
  authorName: { type: String, default: '' },
  fromPlatform: { type: Boolean, default: false },
  body: { type: String, required: true, maxlength: 5000 },
  at: { type: Date, default: Date.now },
});

// Organization → platform support conversation.
const SupportTicketSchema = createSchema(
  {
    ticketNumber: { type: String, required: true },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    category: {
      type: String,
      enum: ['BILLING', 'TECHNICAL', 'ACCOUNT', 'FEATURE_REQUEST', 'OTHER'],
      default: 'OTHER',
    },
    priority: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], default: 'MEDIUM' },
    status: {
      type: String,
      enum: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'],
      default: 'OPEN',
      index: true,
    },
    createdByUserId: userRef({ required: true }),
    messages: { type: [MessageSchema], default: [] },
    lastActivityAt: { type: Date, default: Date.now, index: true },
  },
  { collection: 'saas_support_tickets' },
);

SupportTicketSchema.index({ organizationId: 1, ticketNumber: 1 }, { unique: true });

module.exports = mongoose.models.SupportTicket || mongoose.model('SupportTicket', SupportTicketSchema);
