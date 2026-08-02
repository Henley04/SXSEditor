/**
 * formatBytes.js
 * Byte formatting utilities for SXSEditor-Pad.
 * Formats byte counts to human-readable strings with localized support.
 *
 * @module utils/formatBytes
 */

/**
 * Standard SI unit definitions.
 * @type {Array<{label: string, value: number}>}
 */
const SI_UNITS = [
  { label: 'EB', value: 1e18 },
  { label: 'PB', value: 1e15 },
  { label: 'TB', value: 1e12 },
  { label: 'GB', value: 1e9 },
  { label: 'MB', value: 1e6 },
  { label: 'KB', value: 1e3 },
  { label: 'B', value: 1 },
];

/**
 * Binary (IEC) unit definitions.
 * @type {Array<{label: string, value: number}>}
 */
const IEC_UNITS = [
  { label: 'EiB', value: 2 ** 60 },
  { label: 'PiB', value: 2 ** 50 },
  { label: 'TiB', value: 2 ** 40 },
  { label: 'GiB', value: 2 ** 30 },
  { label: 'MiB', value: 2 ** 20 },
  { label: 'KiB', value: 2 ** 10 },
  { label: 'B', value: 1 },
];

/**
 * Localized unit labels for common locales.
 * Falls back to English labels if locale is not found.
 * @type {Object<string, Object<string, string>>}
 */
const LOCALIZED_LABELS = {
  'zh-CN': {
    B: 'B',
    KB: 'KB',
    MB: 'MB',
    GB: 'GB',
    TB: 'TB',
    PB: 'PB',
    EB: 'EB',
  },
  'ja-JP': {
    B: 'B',
    KB: 'KB',
    MB: 'MB',
    GB: 'GB',
    TB: 'TB',
    PB: 'PB',
    EB: 'EB',
  },
};

/**
 * Get the appropriate unit labels for a locale.
 * @param {string} [locale='en-US'] - BCP 47 locale string
 * @returns {Object<string, string>}
 */
function getLabels(locale = 'en-US') {
  return LOCALIZED_LABELS[locale] || LOCALIZED_LABELS['en-US'] || {};
}

/**
 * Format bytes to a human-readable string using SI (decimal) units.
 * E.g., 1024 -> "1.02 KB", 1536 -> "1.54 KB"
 *
 * @param {number} bytes - Number of bytes
 * @param {Object} [options] - Formatting options
 * @param {number} [options.decimals=2] - Number of decimal places
 * @param {string} [options.locale='en-US'] - Locale for formatting
 * @returns {string} Formatted byte string
 */
export function formatBytes(bytes, options = {}) {
  const { decimals = 2, locale = 'en-US' } = options;

  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
    return '0 B';
  }

  if (bytes < 0) {
    return '-' + formatBytes(-bytes, options);
  }

  if (bytes === 0) {
    return '0 B';
  }

  const labels = getLabels(locale);
  const unit = SI_UNITS.find((u) => bytes >= u.value) || SI_UNITS[SI_UNITS.length - 1];
  const value = bytes / unit.value;
  const label = labels[unit.label] || unit.label;

  return `${value.toFixed(decimals)} ${label}`;
}

/**
 * Format bytes to a human-readable string using IEC (binary) units.
 * E.g., 1024 -> "1.00 KiB", 1536 -> "1.50 KiB"
 *
 * @param {number} bytes - Number of bytes
 * @param {Object} [options] - Formatting options
 * @param {number} [options.decimals=2] - Number of decimal places
 * @param {string} [options.locale='en-US'] - Locale for formatting
 * @returns {string} Formatted byte string
 */
export function formatBytesIEC(bytes, options = {}) {
  const { decimals = 2, locale = 'en-US' } = options;

  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
    return '0 B';
  }

  if (bytes < 0) {
    return '-' + formatBytesIEC(-bytes, options);
  }

  if (bytes === 0) {
    return '0 B';
  }

  const labels = getLabels(locale);
  const unit = IEC_UNITS.find((u) => bytes >= u.value) || IEC_UNITS[IEC_UNITS.length - 1];
  const value = bytes / unit.value;
  const label = labels[unit.label] || unit.label;

  return `${value.toFixed(decimals)} ${label}`;
}

/**
 * Format bytes to a human-readable string, automatically choosing SI or IEC.
 * Uses SI by default, but can be forced to IEC.
 *
 * @param {number} bytes - Number of bytes
 * @param {Object} [options] - Formatting options
 * @param {number} [options.decimals=2] - Number of decimal places
 * @param {string} [options.locale='en-US'] - Locale for formatting
 * @param {boolean} [options.iec=false] - Use IEC (binary) units
 * @returns {string} Formatted byte string
 */
export function formatBytesAuto(bytes, options = {}) {
  if (options.iec) {
    return formatBytesIEC(bytes, options);
  }
  return formatBytes(bytes, options);
}

/**
 * Parse a human-readable byte string back to a number.
 * E.g., "1.5 MB" -> 1500000, "1.5 MiB" -> 1572864
 *
 * @param {string} str - Human-readable byte string
 * @returns {number|null} Number of bytes, or null if parsing fails
 */
export function parseBytes(str) {
  if (typeof str !== 'string') {
    return null;
  }

  const match = str.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|PB|EB|KiB|MiB|GiB|TiB|PiB|EiB)?$/i);
  if (!match) {
    return null;
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();

  // Find the unit in SI units first
  const siUnit = SI_UNITS.find((u) => u.label === unit);
  if (siUnit) {
    return value * siUnit.value;
  }

  // Try IEC units
  const iecUnit = IEC_UNITS.find((u) => u.label === unit);
  if (iecUnit) {
    return value * iecUnit.value;
  }

  return value;
}

export default {
  formatBytes,
  formatBytesIEC,
  formatBytesAuto,
  parseBytes,
};