const ChatThread = require('../models/ChatThread');
const { ok } = require('../utils/respond');
const asyncHandler = require('../utils/asyncHandler');

const ADVISOR_REPLIES = [
  "That's a great question. Let me check and revert in a few minutes.",
  'Sure, I can arrange that. Would Saturday morning work for you?',
  "I'll send you the details right away.",
  'We have flexible payment options. Let me share the brochure.',
  "Absolutely! I'll connect with the builder and update you.",
];

async function findOrCreate(userId) {
  let thread = await ChatThread.findOne({ userId });
  if (!thread) {
    thread = await ChatThread.create({
      userId,
      messages: [
        {
          role: 'advisor',
          text: "Hi there! I'm Priya, your dedicated property advisor. How can I help you today?",
          timestamp: new Date(),
          status: 'sent',
        },
      ],
    });
  }
  return thread;
}

exports.thread = asyncHandler(async (req, res) => {
  const t = await findOrCreate(req.user._id);
  ok(res, t.toPublic());
});

exports.send = asyncHandler(async (req, res) => {
  const t = await findOrCreate(req.user._id);
  t.messages.push({ role: 'user', text: req.body.text, status: 'sent' });
  await t.save();

  // Simulated advisor reply 1.5s later (best-effort, fire-and-forget)
  setTimeout(async () => {
    try {
      const fresh = await ChatThread.findById(t._id);
      if (fresh) {
        fresh.messages.push({
          role: 'advisor',
          text: ADVISOR_REPLIES[Math.floor(Math.random() * ADVISOR_REPLIES.length)],
          status: 'sent',
        });
        fresh.lastActive = new Date();
        await fresh.save();
      }
    } catch (e) {
      // swallow
    }
  }, 1500);

  ok(res, t.toPublic());
});

exports.requestCallback = asyncHandler(async (_req, res) => {
  ok(res, { success: true });
});
