/**
 * debounce.js
 * Debounce and throttle utilities for SXSEditor-Pad.
 *
 * @module utils/debounce
 */

/**
 * Creates a debounced function that delays invoking fn until after `delay` milliseconds
 * have elapsed since the last time the debounced function was invoked.
 *
 * @template T
 * @param {(...args: any[]) => any} fn - The function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {(...args: any[]) => void} Debounced function with a cancel method
 */
export function debounce(fn, delay) {
  if (typeof fn !== 'function') {
    throw new TypeError('Expected a function as first argument');
  }
  if (typeof delay !== 'number' || delay < 0) {
    throw new TypeError('Expected a non-negative number as delay');
  }

  let timerId = null;
  let lastArgs = null;
  let lastContext = null;

  const debounced = function (...args) {
    lastArgs = args;
    lastContext = this;

    if (timerId !== null) {
      clearTimeout(timerId);
    }

    timerId = setTimeout(() => {
      timerId = null;
      fn.apply(lastContext, lastArgs);
      lastArgs = null;
      lastContext = null;
    }, delay);
  };

  /**
   * Cancel any pending invocation.
   */
  debounced.cancel = function () {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    lastArgs = null;
    lastContext = null;
  };

  /**
   * Immediately invoke any pending invocation and cancel.
   */
  debounced.flush = function () {
    if (timerId !== null && lastArgs !== null) {
      clearTimeout(timerId);
      timerId = null;
      fn.apply(lastContext, lastArgs);
      lastArgs = null;
      lastContext = null;
    }
  };

  /**
   * Returns whether there is a pending invocation.
   * @returns {boolean}
   */
  debounced.pending = function () {
    return timerId !== null;
  };

  return debounced;
}

/**
 * Creates a throttled function that only invokes fn at most once per `limit` milliseconds.
 *
 * @template T
 * @param {(...args: any[]) => any} fn - The function to throttle
 * @param {number} limit - Throttle interval in milliseconds
 * @param {{ leading?: boolean, trailing?: boolean }} [options] - Options
 * @param {boolean} [options.leading=true] - Invoke on the leading edge
 * @param {boolean} [options.trailing=true] - Invoke on the trailing edge
 * @returns {(...args: any[]) => void} Throttled function with a cancel method
 */
export function throttle(fn, limit, options = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('Expected a function as first argument');
  }
  if (typeof limit !== 'number' || limit < 0) {
    throw new TypeError('Expected a non-negative number as limit');
  }

  const { leading = true, trailing = true } = options;
  let inThrottle = false;
  let lastArgs = null;
  let lastContext = null;
  let timerId = null;

  const throttled = function (...args) {
    lastArgs = args;
    lastContext = this;

    if (!inThrottle) {
      if (leading) {
        fn.apply(lastContext, lastArgs);
        lastArgs = null;
        lastContext = null;
      }
      inThrottle = true;

      timerId = setTimeout(() => {
        inThrottle = false;
        if (trailing && lastArgs !== null) {
          fn.apply(lastContext, lastArgs);
          lastArgs = null;
          lastContext = null;
        }
        timerId = null;
      }, limit);
    }
  };

  /**
   * Cancel any pending trailing invocation.
   */
  throttled.cancel = function () {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    inThrottle = false;
    lastArgs = null;
    lastContext = null;
  };

  /**
   * Immediately invoke any pending trailing invocation.
   */
  throttled.flush = function () {
    if (lastArgs !== null) {
      fn.apply(lastContext, lastArgs);
      lastArgs = null;
      lastContext = null;
    }
  };

  return throttled;
}

/**
 * Creates a debounced async function that returns a Promise.
 * The returned promise resolves when the debounced function completes.
 * If called again while pending, the previous invocation's promise rejects
 * and a new one is created.
 *
 * @template T
 * @param {(...args: any[]) => Promise<any>} fn - The async function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {(...args: any[]) => Promise<any>} Debounced async function
 */
export function debounceAsync(fn, delay) {
  if (typeof fn !== 'function') {
    throw new TypeError('Expected a function as first argument');
  }
  if (typeof delay !== 'number' || delay < 0) {
    throw new TypeError('Expected a non-negative number as delay');
  }

  let timerId = null;
  let rejectPrev = null;

  const debounced = function (...args) {
    const context = this;

    // Reject previous pending promise if any
    if (rejectPrev) {
      rejectPrev(new Error('Debounced function was called again'));
      rejectPrev = null;
    }

    // Clear previous timer
    if (timerId !== null) {
      clearTimeout(timerId);
    }

    return new Promise((resolve, reject) => {
      rejectPrev = reject;

      timerId = setTimeout(async () => {
        timerId = null;
        rejectPrev = null;
        try {
          const result = await fn.apply(context, args);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }, delay);
    });
  };

  /**
   * Cancel any pending invocation.
   */
  debounced.cancel = function () {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (rejectPrev) {
      rejectPrev(new Error('Debounced function was cancelled'));
      rejectPrev = null;
    }
  };

  return debounced;
}

export default {
  debounce,
  throttle,
  debounceAsync,
};