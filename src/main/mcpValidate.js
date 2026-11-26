'use strict';
/**
 * Minimal JSON-Schema validator for the MCP method table.
 *
 * Scope is deliberately small: object/array/string/number/integer/boolean,
 * required, additionalProperties, enum, numeric bounds, array bounds. That is
 * everything src/shared/mcpSchema.js uses. Failures are reported per field so
 * callers get `field` + a human hint instead of a bare "bad request".
 */

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
};

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function validate(value, schema, field = '', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const check = TYPE_CHECKS[schema.type];
    if (check && !check(value)) {
      errors.push({ field: field || '(root)', message: `expected ${schema.type}, got ${typeName(value)}` });
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ field: field || '(root)', message: `must be one of ${schema.enum.join(', ')}`, hint: `got ${JSON.stringify(value)}` });
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ field, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ field, message: `must be <= ${schema.maximum}` });
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push({ field, message: `must be > ${schema.exclusiveMinimum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ field, message: `must contain at least ${schema.minItems} item(s)` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ field, message: `must contain at most ${schema.maxItems} item(s)` });
    }
    if (schema.items) {
      value.forEach((item, i) => validate(item, schema.items, `${field}[${i}]`, errors));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    for (const key of schema.required || []) {
      if (value[key] === undefined) {
        errors.push({ field: field ? `${field}.${key}` : key, message: 'is required' });
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (value[key] !== undefined) validate(value[key], propSchema, field ? `${field}.${key}` : key, errors);
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          errors.push({
            field: field ? `${field}.${key}` : key,
            message: 'unknown parameter',
            hint: `known: ${[...known].join(', ')}`,
          });
        }
      }
    }
  }

  return errors;
}

/**
 * Apply legacy parameter aliases, then validate.
 * @returns {{ok:boolean, value:object, errors:Array, warnings:Array}}
 */
function validateParams(method, params) {
  const def = method;
  const input = (params && typeof params === 'object' && !Array.isArray(params)) ? { ...params } : {};
  const warnings = [];

  for (const [from, to] of Object.entries(def.aliases || {})) {
    if (input[from] !== undefined) {
      if (input[to] === undefined) input[to] = input[from];
      delete input[from];
      warnings.push({ code: 'ALIAS_DEPRECATED', message: `parameter "${from}" is deprecated; use "${to}"` });
    }
  }

  // Legacy `project.replace` nesting: {project:{project:{...},singers,fragments}}.
  if (input.project && typeof input.project === 'object' && input.project.project && input.project.singers === undefined) {
    input.project = input.project.project;
    warnings.push({ code: 'ALIAS_DEPRECATED', message: 'project.replace takes the document directly under "project"' });
  }

  const errors = [];
  if (def.params) validate(input, def.params, '', errors);
  return { ok: errors.length === 0, value: input, errors, warnings };
}

module.exports = { validate, validateParams };
