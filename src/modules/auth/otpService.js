const crypto = require('crypto');
const env = require('../../config/env');
const Otp = require('./Otp');
const sms = require('../notifications/channels/sms');
const { tooMany, unauthorized } = require('../core/errors');
const { safeEqual } = require('./tokens');

// OTP protection:
//   * codes are stored as keyed hashes, never in plain text
//   * short expiry, single use, max verification attempts per code
//   * per-phone send limits (cooldown + hourly cap) on top of IP limits
//   * OTP_MODE=fixed (dev/staging only — refused in production) keeps the
//     historical demo code so existing test builds keep working.

const hashCode = (phone, code) =>
  crypto.createHmac('sha256', env.JWT_SECRET).update(`${phone}:${String(code)}`).digest('hex');

const generateCode = () => {
  if (env.OTP_MODE === 'fixed') return env.OTP_FIXED_CODE;
  const len = Math.min(8, Math.max(4, env.OTP_LENGTH));
  return String(crypto.randomInt(0, 10 ** len)).padStart(len, '0');
};

const sendOtp = async (phone, { ip = '' } = {}) => {
  const now = Date.now();
  const recent = await Otp.find({ phone, createdAt: { $gte: new Date(now - 3600 * 1000) } })
    .sort({ createdAt: -1 })
    .select('createdAt')
    .lean();
  if (recent.length >= env.OTP_MAX_SENDS_PER_HOUR) {
    throw tooMany('Too many OTP requests for this number. Please try again later.');
  }
  if (recent[0]) {
    const elapsed = now - new Date(recent[0].createdAt).getTime();
    const cooldown = env.OTP_RESEND_COOLDOWN_SECONDS * 1000;
    if (elapsed < cooldown) {
      const retryAfter = Math.ceil((cooldown - elapsed) / 1000);
      throw tooMany(`Please wait ${retryAfter}s before requesting another OTP.`, { retryAfter });
    }
  }

  // Older unused codes stop working the moment a new one is issued.
  await Otp.updateMany({ phone, consumedAt: null }, { $set: { consumedAt: new Date(now) } });

  const code = generateCode();
  await Otp.create({
    phone,
    codeHash: hashCode(phone, code),
    expiresAt: new Date(now + env.OTP_TTL_SECONDS * 1000),
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    ip,
  });

  if (env.OTP_MODE === 'random') await sms.sendOtp(phone, code);

  const echo = env.OTP_MODE === 'fixed' || env.OTP_DEV_ECHO;
  return { sent: true, expiresIn: env.OTP_TTL_SECONDS, ...(echo ? { otp: code } : {}) };
};

const verifyOtp = async (phone, code) => {
  const now = new Date();
  const otp = await Otp.findOne({ phone, consumedAt: null, expiresAt: { $gt: now } }).sort({ createdAt: -1 });
  if (!otp) throw unauthorized('This OTP has expired. Please request a new one.', 'OTP_EXPIRED');

  const counted = await Otp.findOneAndUpdate(
    { _id: otp._id, consumedAt: null, attempts: { $lt: otp.maxAttempts } },
    { $inc: { attempts: 1 } },
    { new: true },
  );
  if (!counted) {
    await Otp.updateOne({ _id: otp._id }, { $set: { consumedAt: now } });
    throw tooMany('Too many incorrect attempts. Please request a new OTP.');
  }

  if (!safeEqual(hashCode(phone, code), otp.codeHash)) {
    if (counted.attempts >= counted.maxAttempts) {
      await Otp.updateOne({ _id: otp._id }, { $set: { consumedAt: now } });
    }
    throw unauthorized('Invalid OTP', 'OTP_INVALID');
  }

  const consumed = await Otp.findOneAndUpdate({ _id: otp._id, consumedAt: null }, { $set: { consumedAt: now } });
  if (!consumed) throw unauthorized('This OTP was already used. Please request a new one.', 'OTP_USED');
  return true;
};

module.exports = { sendOtp, verifyOtp, hashCode };
