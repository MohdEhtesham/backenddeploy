function ok(res, data, message) {
  return res.json({ success: true, data, message });
}

function created(res, data, message) {
  return res.status(201).json({ success: true, data, message });
}

function fail(res, status, message, details) {
  return res.status(status).json({ success: false, message, details });
}

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

module.exports = { ok, created, fail, ApiError };
