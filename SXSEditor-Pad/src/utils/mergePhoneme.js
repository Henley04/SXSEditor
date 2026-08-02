/**
 * mergePhoneme.js
 * Phoneme merging utilities for SXSEditor-Pad.
 * Merges adjacent phonemes with the same properties and optimizes
 * phoneme sequences for synthesis.
 *
 * @module utils/mergePhoneme
 */

/**
 * @typedef {Object} Phoneme
 * @property {string} symbol - Phoneme symbol (e.g., 'a', 'sh', 'sil')
 * @property {number} start - Start time in seconds
 * @property {number} end - End time in seconds
 * @property {number} [pitch] - Optional pitch value in Hz
 * @property {number} [intensity] - Optional intensity value (0-1)
 * @property {string} [type] - Phoneme type: 'vowel', 'consonant', 'silence', 'diphthong'
 * @property {string} [language] - Optional language code
 * @property {Object} [features] - Additional phoneme features
 */

/**
 * Properties that are compared for merging adjacency.
 * @type {string[]}
 */
const MERGE_PROPERTIES = ['symbol', 'type', 'language', 'pitch'];

/**
 * Default properties for missing phoneme fields.
 * @type {Object}
 */
const DEFAULT_PHONEME = {
  symbol: '',
  start: 0,
  end: 0,
  type: 'unknown',
};

/**
 * Check if two phonemes are adjacent in time.
 *
 * @param {Phoneme} a - First phoneme
 * @param {Phoneme} b - Second phoneme
 * @param {number} [tolerance=0.001] - Time tolerance in seconds for adjacency
 * @returns {boolean} True if the phonemes are adjacent
 */
export function areAdjacent(a, b, tolerance = 0.001) {
  if (!a || !b) return false;
  return Math.abs(a.end - b.start) <= tolerance;
}

/**
 * Check if two phonemes have the same merge-relevant properties.
 *
 * @param {Phoneme} a - First phoneme
 * @param {Phoneme} b - Second phoneme
 * @returns {boolean} True if the phonemes have matching properties
 */
export function haveSameProperties(a, b) {
  if (!a || !b) return false;

  for (const prop of MERGE_PROPERTIES) {
    if (a[prop] !== b[prop]) {
      return false;
    }
  }

  // Compare features if both have them
  if (a.features && b.features) {
    const aKeys = Object.keys(a.features).sort();
    const bKeys = Object.keys(b.features).sort();
    if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) return false;
    for (const key of aKeys) {
      if (a.features[key] !== b.features[key]) return false;
    }
  } else if (a.features || b.features) {
    return false;
  }

  return true;
}

/**
 * Merge two adjacent phonemes with the same properties into one.
 * The merged phoneme spans from the start of the first to the end of the second.
 *
 * @param {Phoneme} a - First phoneme
 * @param {Phoneme} b - Second phoneme
 * @returns {Phoneme|null} Merged phoneme, or null if they cannot be merged
 */
export function mergeTwo(a, b) {
  if (!areAdjacent(a, b)) return null;
  if (!haveSameProperties(a, b)) return null;

  // Average pitch if both have it
  let mergedPitch;
  if (a.pitch !== undefined && b.pitch !== undefined) {
    mergedPitch = (a.pitch + b.pitch) / 2;
  } else if (a.pitch !== undefined) {
    mergedPitch = a.pitch;
  } else if (b.pitch !== undefined) {
    mergedPitch = b.pitch;
  }

  // Average intensity if both have it
  let mergedIntensity;
  if (a.intensity !== undefined && b.intensity !== undefined) {
    mergedIntensity = (a.intensity + b.intensity) / 2;
  } else if (a.intensity !== undefined) {
    mergedIntensity = a.intensity;
  } else if (b.intensity !== undefined) {
    mergedIntensity = b.intensity;
  }

  return {
    ...a,
    end: b.end,
    pitch: mergedPitch,
    intensity: mergedIntensity,
  };
}

/**
 * Check if a phoneme is a silence/phoneme boundary.
 *
 * @param {Phoneme} phoneme - Phoneme to check
 * @returns {boolean}
 */
export function isSilence(phoneme) {
  if (!phoneme) return false;
  const symbol = (phoneme.symbol || '').toLowerCase();
  return symbol === 'sil' ||
    symbol === 'sp' ||
    symbol === 'sp1' ||
    symbol === 'silence' ||
    symbol === 'pause' ||
    symbol === 'br' ||
    phoneme.type === 'silence' ||
    phoneme.type === 'pause';
}

/**
 * Merge adjacent phonemes with the same properties in a sequence.
 * Processes the phoneme list from left to right, merging compatible
 * adjacent phonemes.
 *
 * @param {Phoneme[]} phonemes - Array of phonemes to merge
 * @param {Object} [options] - Merge options
 * @param {boolean} [options.mergeSilence=true] - Whether to merge adjacent silence phonemes
 * @param {boolean} [options.mergeSame=true] - Whether to merge phonemes with same symbol
 * @param {number} [options.timeTolerance=0.001] - Time tolerance for adjacency
 * @returns {Phoneme[]} Merged phoneme sequence
 */
export function mergePhonemes(phonemes, options = {}) {
  if (!Array.isArray(phonemes) || phonemes.length === 0) {
    return [];
  }

  const {
    mergeSilence = true,
    mergeSame = true,
    timeTolerance = 0.001,
  } = options;

  const result = [];
  let current = { ...DEFAULT_PHONEME, ...phonemes[0] };

  for (let i = 1; i < phonemes.length; i++) {
    const next = { ...DEFAULT_PHONEME, ...phonemes[i] };

    // Check if we should skip merging based on silence/type rules
    const shouldMergeByType = mergeSame ||
      (mergeSilence && isSilence(current) && isSilence(next));

    // Check if we can merge
    if (shouldMergeByType && areAdjacent(current, next, timeTolerance) && haveSameProperties(current, next)) {
      const merged = mergeTwo(current, next);
      if (merged) {
        current = merged;
        continue;
      }
    }

    // Cannot merge, push current and move to next
    result.push(current);
    current = { ...next };
  }

  // Push the last phoneme
  result.push(current);

  return result;
}

/**
 * Remove silence phonemes shorter than a threshold.
 * Useful for cleaning up very short silence segments that don't
 * contribute to synthesis quality.
 *
 * @param {Phoneme[]} phonemes - Array of phonemes to filter
 * @param {number} [minDuration=0.01] - Minimum silence duration in seconds
 * @returns {Phoneme[]} Filtered phoneme sequence
 */
export function removeShortSilences(phonemes, minDuration = 0.01) {
  if (!Array.isArray(phonemes)) return [];

  return phonemes.filter((p) => {
    if (isSilence(p)) {
      return (p.end - p.start) >= minDuration;
    }
    return true;
  });
}

/**
 * Optimize a phoneme sequence for synthesis.
 * This includes merging compatible phonemes, removing short silences,
 * and normalizing the sequence.
 *
 * @param {Phoneme[]} phonemes - Input phoneme sequence
 * @param {Object} [options] - Optimization options
 * @returns {Phoneme[]} Optimized phoneme sequence
 */
export function optimizePhonemes(phonemes, options = {}) {
  if (!Array.isArray(phonemes) || phonemes.length === 0) {
    return [];
  }

  const {
    mergeSilence = true,
    mergeSame = true,
    removeShortSilence = true,
    minSilenceDuration = 0.01,
    timeTolerance = 0.001,
  } = options;

  let result = [...phonemes];

  // Step 1: Remove very short silence segments
  if (removeShortSilence) {
    result = removeShortSilences(result, minSilenceDuration);
  }

  // Step 2: Merge compatible adjacent phonemes
  result = mergePhonemes(result, {
    mergeSilence,
    mergeSame,
    timeTolerance,
  });

  return result;
}

/**
 * Convert a phoneme sequence to a string representation.
 *
 * @param {Phoneme[]} phonemes - Array of phonemes
 * @returns {string} String representation
 */
export function phonemesToString(phonemes) {
  if (!Array.isArray(phonemes)) return '';
  return phonemes.map((p) => {
    const sym = p.symbol || '?';
    return `${sym}[${p.start.toFixed(3)}-${p.end.toFixed(3)}]`;
  }).join(' ');
}

export default {
  areAdjacent,
  haveSameProperties,
  mergeTwo,
  isSilence,
  mergePhonemes,
  removeShortSilences,
  optimizePhonemes,
  phonemesToString,
};