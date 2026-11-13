const mongoose = require('mongoose');

// Atomic, per-organization sequences for human-readable document numbers
// (INV-2026-00042, RCPT-2026-00017 …). One document per (org, type, year).
const CounterSchema = new mongoose.Schema(
  { _id: String, seq: { type: Number, default: 0 } },
  { collection: 'saas_counters', versionKey: false },
);
const Counter = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);

const nextSeq = async (key, session) => {
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session: session || undefined },
  );
  return doc.seq;
};

const nextNumber = async (orgId, type, prefix, session, date = new Date()) => {
  const year = date.getUTCFullYear();
  const seq = await nextSeq(`${orgId}:${type}:${year}`, session);
  return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
};

module.exports = { Counter, nextSeq, nextNumber };
