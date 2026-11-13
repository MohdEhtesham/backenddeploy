const { publicDoc } = require('./schema');

const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive "contains" search across whitelisted fields. */
const buildSearch = (q, fields) => {
  if (!q || typeof q !== 'string' || !fields || !fields.length) return null;
  const safe = escapeRegex(q.trim().slice(0, 100));
  if (!safe) return null;
  const re = new RegExp(safe, 'i');
  return { $or: fields.map(f => ({ [f]: re })) };
};

/**
 * Normalize validated list query params into Mongo pagination / sort.
 * Sorting is restricted to a whitelist and always tie-broken on _id so
 * pages are stable.
 */
const listOptions = (query, { sortable = ['createdAt'], defaultSort = '-createdAt', searchFields = [] } = {}) => {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  let raw = typeof query.sort === 'string' && query.sort ? query.sort : defaultSort;
  let field = raw.replace(/^[-+]/, '');
  if (!sortable.includes(field)) {
    raw = defaultSort;
    field = raw.replace(/^[-+]/, '');
  }
  const dir = raw.startsWith('-') ? -1 : 1;
  return {
    page,
    pageSize,
    sort: { [field]: dir, _id: dir },
    search: buildSearch(query.q, searchFields),
  };
};

/** Run a paginated find + count and wrap in the standard list envelope. */
const paginate = async (Model, filter, opts, { select, map, populate } = {}) => {
  const { page, pageSize, sort, search } = opts;
  const where = search ? { ...filter, ...search } : filter;
  let q = Model.find(where).sort(sort).skip((page - 1) * pageSize).limit(pageSize);
  if (select) q = q.select(select);
  if (populate) q = q.populate(populate);
  const [rows, total] = await Promise.all([q.lean(), Model.countDocuments(where)]);
  const items = rows.map(r => (map ? map(publicDoc(r), r) : publicDoc(r)));
  return { items, total, page, pageSize, hasMore: page * pageSize < total };
};

const listResult = (items, total, page, pageSize) => ({
  items,
  total,
  page,
  pageSize,
  hasMore: page * pageSize < total,
});

module.exports = { escapeRegex, buildSearch, listOptions, paginate, listResult };
