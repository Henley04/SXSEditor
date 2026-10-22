'use strict';
/** Structured errors for the automation bridge. */

const CODES = {
  VALIDATION_ERROR: 400,
  UNKNOWN_METHOD: 404,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 422,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  CANCELLED: 409,
  INTERNAL: 500,
};

class McpError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'McpError';
    this.code = CODES[code] ? code : 'INTERNAL';
    this.field = extra.field;
    this.hint = extra.hint;
    this.details = extra.details;
    this.status = CODES[this.code] || 500;
  }

  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.field) out.field = this.field;
    if (this.hint) out.hint = this.hint;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

/** Renderer replies carry {code, message, field, hint}; upgrade them. */
function normalizeError(err) {
  if (err instanceof McpError) return err;
  if (err && typeof err === 'object' && typeof err.code === 'string' && CODES[err.code]) {
    return new McpError(err.code, err.message, err);
  }
  if (err && typeof err === 'object' && Array.isArray(err.errors) && err.errors.length) {
    const first = err.errors[0];
    return new McpError('VALIDATION_ERROR', first.message, {
      field: first.field,
      hint: first.hint || `known values: ${err.errors.slice(0, 5).map((e) => e.field).join(', ')}`,
      details: { errors: err.errors.slice(0, 20) },
    });
  }
  const message = (err && err.message) || String(err || 'Automation failed');
  if (/timeout/i.test(message)) return new McpError('TIMEOUT', message);
  if (/Unknown fragment|Unknown singer|not found/i.test(message)) {
    return new McpError('NOT_FOUND', message, { hint: 'list ids with project.get' });
  }
  if (/authoriz|not allowed|forbidden|system path/i.test(message)) {
    return new McpError('FORBIDDEN', message, { hint: 'grant the directory with session.grantRoot' });
  }
  return new McpError('INTERNAL', message);
}

function fail(code, message, extra) {
  throw new McpError(code, message, extra);
}

module.exports = { CODES, McpError, normalizeError, fail };
