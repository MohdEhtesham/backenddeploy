const mongoose = require('mongoose');

// Multi-document transactions need a replica set (Atlas, the docker-compose
// Mongo and the test replica set all are). On a standalone dev mongod we
// degrade to running without a session — correctness-critical invariants
// (bed claims, payment confirmation) are ALSO enforced by atomic
// conditional updates and unique indexes, so they hold either way.

let supported = null;

const detectTransactionSupport = async () => {
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    supported = Boolean(hello.setName || hello.msg === 'isdbgrid');
  } catch {
    supported = false;
  }
  if (!supported) {
    console.warn('[db] MongoDB is not a replica set — multi-document transactions disabled.');
  }
  return supported;
};

const resetTransactionSupport = () => {
  supported = null;
};

/**
 * Run `fn(session)` inside a transaction (retried by the driver on
 * transient errors, so `fn` must only touch the database). Side effects
 * such as notifications belong AFTER this resolves.
 */
const withTransaction = async fn => {
  if (supported === null) await detectTransactionSupport();
  if (!supported) return fn(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

module.exports = { withTransaction, detectTransactionSupport, resetTransactionSupport };
