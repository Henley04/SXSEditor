/**
 * gpuCache.js
 * GPU cache manager for SXSEditor-Pad.
 * Provides memory-efficient caching for GPU-related data with
 * automatic cache invalidation and size limits.
 *
 * @module utils/gpuCache
 */

/**
 * Default maximum number of entries in the cache.
 * @type {number}
 */
const DEFAULT_MAX_ENTRIES = 50;

/**
 * Default maximum cache size in bytes (100 MB).
 * @type {number}
 */
const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024;

/**
 * Default TTL in milliseconds (5 minutes).
 * @type {number}
 */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * @typedef {Object} CacheEntry
 * @property {*} value - Cached value
 * @property {number} size - Estimated size of the value in bytes
 * @property {number} timestamp - When the entry was created
 * @property {number} expiresAt - When the entry expires
 * @property {number} hits - Number of times this entry was accessed
 * @property {string} key - Original cache key
 */

/**
 * GPU cache manager for storing and retrieving GPU-related data.
 * Supports TTL-based expiration, LRU-like eviction, and size limits.
 */
export class GpuCache {
  /**
   * @param {Object} [options] - Cache configuration
   * @param {number} [options.maxEntries=50] - Maximum number of cache entries
   * @param {number} [options.maxSizeBytes=104857600] - Maximum cache size in bytes
   * @param {number} [options.ttlMs=300000] - Time-to-live in milliseconds
   */
  constructor(options = {}) {
    /** @type {Map<string, CacheEntry>} */
    this._cache = new Map();
    this._maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this._maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    this._ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this._currentSize = 0;
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  /**
   * Estimate the byte size of a value.
   * For typed arrays and ArrayBuffers, uses their byteLength.
   * For other objects, performs a rough estimate.
   *
   * @param {*} value - The value to estimate
   * @returns {number} Estimated size in bytes
   */
  _estimateSize(value) {
    if (value === null || value === undefined) return 0;

    if (value instanceof ArrayBuffer) {
      return value.byteLength;
    }

    if (ArrayBuffer.isView(value)) {
      return value.byteLength;
    }

    if (value instanceof Blob) {
      return value.size;
    }

    if (typeof value === 'string') {
      return value.length * 2; // UTF-16
    }

    if (typeof value === 'number') {
      return 8;
    }

    if (typeof value === 'boolean') {
      return 4;
    }

    if (Array.isArray(value)) {
      let total = 0;
      for (let i = 0; i < Math.min(value.length, 100); i++) {
        total += this._estimateSize(value[i]);
      }
      // Rough estimate: average of sampled elements * total length
      if (value.length > 100) {
        total = (total / 100) * value.length;
      }
      return total;
    }

    if (typeof value === 'object') {
      try {
        const str = JSON.stringify(value);
        return str ? str.length * 2 : 128;
      } catch {
        return 1024; // Conservative default for complex objects
      }
    }

    return 64; // Default for unknown types
  }

  /**
   * Evict expired entries from the cache.
   */
  _evictExpired() {
    const now = Date.now();
    for (const [key, entry] of this._cache) {
      if (now >= entry.expiresAt) {
        this._cache.delete(key);
        this._currentSize -= entry.size;
        this._evictions++;
      }
    }
  }

  /**
   * Evict entries to make room for new data.
   * Evicts the least recently accessed (oldest timestamp) entries first.
   *
   * @param {number} neededSize - Size needed for the new entry
   */
  _makeRoom(neededSize) {
    // First, evict expired entries
    this._evictExpired();

    // If still over limit, evict oldest entries
    while (
      (this._cache.size >= this._maxEntries ||
        this._currentSize + neededSize > this._maxSizeBytes) &&
      this._cache.size > 0
    ) {
      // Find the entry with the oldest timestamp (simplified LRU)
      let oldestKey = null;
      let oldestTime = Infinity;

      for (const [key, entry] of this._cache) {
        if (entry.timestamp < oldestTime) {
          oldestTime = entry.timestamp;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        const evicted = this._cache.get(oldestKey);
        this._cache.delete(oldestKey);
        this._currentSize -= evicted.size;
        this._evictions++;
      }
    }
  }

  /**
   * Set a value in the cache.
   *
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   * @param {Object} [options] - Per-entry options
   * @param {number} [options.ttlMs] - TTL for this specific entry
   * @param {number} [options.size] - Explicit size in bytes (auto-estimated if not provided)
   * @returns {boolean} Whether the value was successfully cached
   */
  set(key, value, options = {}) {
    if (typeof key !== 'string' || key.length === 0) {
      return false;
    }

    const size = options.size ?? this._estimateSize(value);
    const ttl = options.ttlMs ?? this._ttlMs;
    const now = Date.now();

    // If the entry already exists, remove it first
    if (this._cache.has(key)) {
      const existing = this._cache.get(key);
      this._currentSize -= existing.size;
      this._cache.delete(key);
    }

    // Make room for the new entry
    this._makeRoom(size);

    // Check if we can fit the entry
    if (size > this._maxSizeBytes) {
      return false; // Entry too large for cache
    }

    const entry = {
      value,
      size,
      timestamp: now,
      expiresAt: now + ttl,
      hits: 0,
      key,
    };

    this._cache.set(key, entry);
    this._currentSize += size;
    return true;
  }

  /**
   * Get a value from the cache.
   *
   * @param {string} key - Cache key
   * @returns {*|undefined} Cached value, or undefined if not found or expired
   */
  get(key) {
    if (typeof key !== 'string' || !this._cache.has(key)) {
      this._misses++;
      return undefined;
    }

    const entry = this._cache.get(key);
    const now = Date.now();

    // Check expiration
    if (now >= entry.expiresAt) {
      this._cache.delete(key);
      this._currentSize -= entry.size;
      this._evictions++;
      this._misses++;
      return undefined;
    }

    entry.hits++;
    this._hits++;
    return entry.value;
  }

  /**
   * Check if a key exists in the cache and is not expired.
   *
   * @param {string} key - Cache key
   * @returns {boolean}
   */
  has(key) {
    if (typeof key !== 'string' || !this._cache.has(key)) {
      return false;
    }

    const entry = this._cache.get(key);
    if (Date.now() >= entry.expiresAt) {
      this._cache.delete(key);
      this._currentSize -= entry.size;
      this._evictions++;
      return false;
    }

    return true;
  }

  /**
   * Delete a specific entry from the cache.
   *
   * @param {string} key - Cache key
   * @returns {boolean} Whether the entry was deleted
   */
  delete(key) {
    if (this._cache.has(key)) {
      const entry = this._cache.get(key);
      this._currentSize -= entry.size;
      return this._cache.delete(key);
    }
    return false;
  }

  /**
   * Clear all entries from the cache.
   */
  clear() {
    this._cache.clear();
    this._currentSize = 0;
  }

  /**
   * Invalidate all entries matching a key prefix.
   *
   * @param {string} prefix - Key prefix to match
   * @returns {number} Number of invalidated entries
   */
  invalidatePrefix(prefix) {
    let count = 0;
    for (const key of this._cache.keys()) {
      if (key.startsWith(prefix)) {
        const entry = this._cache.get(key);
        this._currentSize -= entry.size;
        this._cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Get the number of entries in the cache.
   * @returns {number}
   */
  get size() {
    return this._cache.size;
  }

  /**
   * Get the current estimated cache size in bytes.
   * @returns {number}
   */
  get currentSize() {
    return this._currentSize;
  }

  /**
   * Get cache statistics.
   * @returns {{ size: number, maxEntries: number, currentSize: number, maxSizeBytes: number, hits: number, misses: number, evictions: number, hitRate: number }}
   */
  get stats() {
    const total = this._hits + this._misses;
    return {
      size: this._cache.size,
      maxEntries: this._maxEntries,
      currentSize: this._currentSize,
      maxSizeBytes: this._maxSizeBytes,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      hitRate: total > 0 ? this._hits / total : 0,
    };
  }
}

/**
 * Create a singleton GPU cache instance with default settings.
 * @type {GpuCache}
 */
export const gpuCache = new GpuCache();

export default {
  GpuCache,
  gpuCache,
};