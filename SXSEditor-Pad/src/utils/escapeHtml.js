/**
 * escapeHtml.js
 * HTML escaping utilities for SXSEditor-Pad.
 * Prevents XSS in user-generated content.
 *
 * @module utils/escapeHtml
 */

/**
 * Map of HTML special characters to their escaped equivalents.
 * @type {Object<string, string>}
 */
const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

/**
 * Regex pattern matching all HTML special characters.
 * @type {RegExp}
 */
const ESCAPE_REGEX = /[&<>"'/`=]/g;

/**
 * Escape HTML special characters to prevent XSS.
 * Converts &, <, >, ", ', /, `, and = to their HTML entity equivalents.
 *
 * @param {string} str - The string to escape
 * @returns {string} The escaped string safe for HTML insertion
 */
export function escapeHtml(str) {
  if (typeof str !== 'string') {
    return '';
  }
  return str.replace(ESCAPE_REGEX, (char) => ESCAPE_MAP[char] || char);
}

/**
 * Create a safe HTML attribute value by escaping special characters.
 * Wraps the value in double quotes for safe attribute insertion.
 *
 * @param {string} value - The attribute value to escape
 * @returns {string} Safe attribute value wrapped in double quotes
 */
export function escapeHtmlAttr(value) {
  if (typeof value !== 'string') {
    return '""';
  }
  return `"${value.replace(/["'`=<>]/g, (char) => ESCAPE_MAP[char] || char)}"`;
}

/**
 * Strip HTML tags from a string, leaving only text content.
 * Note: This is NOT a security measure - use escapeHtml for that.
 * This is for display/cleanup purposes only.
 *
 * @param {string} str - The string to strip HTML from
 * @returns {string} Text content with HTML tags removed
 */
export function stripHtml(str) {
  if (typeof str !== 'string') {
    return '';
  }
  return str.replace(/<[^>]*>/g, '');
}

/**
 * Safely interpolate values into an HTML template.
 * Each value in the template (${key}) is replaced with its escaped form.
 *
 * @param {string} template - HTML template with ${key} placeholders
 * @param {Object<string, string>} values - Map of keys to values
 * @returns {string} Safe HTML string
 */
export function safeHtml(template, values) {
  if (typeof template !== 'string') {
    return '';
  }
  if (!values || typeof values !== 'object') {
    return template;
  }
  return template.replace(/\$\{(\w+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return escapeHtml(String(values[key]));
    }
    return match;
  });
}

export default {
  escapeHtml,
  escapeHtmlAttr,
  stripHtml,
  safeHtml,
};