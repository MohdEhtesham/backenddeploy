const { AsyncLocalStorage } = require('async_hooks');

// Per-async-call flags consulted by the tenancy / soft-delete plugins.
// Using AsyncLocalStorage (instead of query options) keeps the flags out of
// anything forwarded to the MongoDB driver, and makes every bypass an
// explicit, greppable call site: unscoped(...) / withDeleted(...).
const als = new AsyncLocalStorage();

const flags = () => als.getStore() || {};

const runWith = (extra, fn) =>
  als.run({ ...flags(), ...extra }, async () => {
    // `await` inside the context so thenables (Mongoose queries) execute
    // — and their middleware runs — while the flag is still set.
    return await fn();
  });

/** Run platform-level code that legitimately reads across organizations. */
const unscoped = fn => runWith({ unscoped: true }, fn);

/** Include soft-deleted documents in the queries run by `fn`. */
const withDeleted = fn => runWith({ withDeleted: true }, fn);

module.exports = { flags, unscoped, withDeleted };
