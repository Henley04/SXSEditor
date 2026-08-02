/**
 * gpuWorker.js
 * GPU Web Worker for SXSEditor-Pad.
 * Offloads heavy GPU computations from the main thread via postMessage.
 *
 * @module utils/gpuWorker
 */

/**
 * Supported operation types for the GPU worker.
 * @typedef {'inference' | 'tensorOp' | 'memoryOp' | 'benchmark' | 'status'} WorkerOperation
 */

/**
 * @typedef {Object} WorkerMessage
 * @property {string} id - Unique message identifier
 * @property {WorkerOperation} type - Operation type
 * @property {*} [payload] - Operation payload
 */

/**
 * @typedef {Object} WorkerResponse
 * @property {string} id - Original message identifier
 * @property {string} type - Response type
 * @property {boolean} success - Whether the operation succeeded
 * @property {*} [result] - Result data
 * @property {string} [error] - Error message if failed
 * @property {number} [duration] - Operation duration in ms
 */

/**
 * Create a GPU worker instance.
 * The worker script is created inline as a Blob to support all bundlers.
 *
 * @returns {Worker} A Web Worker instance for GPU operations
 */
export function createGpuWorker() {
  const workerCode = `
    /**
     * GPU Worker - runs in a separate thread.
     * Handles heavy GPU computations without blocking the main thread.
     */

    /** @type {Object<string, { resolve: Function, reject: Function }>} */
    const pendingOps = new Map();
    let operationCounter = 0;
    let currentSession = null;

    /**
     * Send a response back to the main thread.
     * @param {string} id - Message ID
     * @param {boolean} success - Whether operation succeeded
     * @param {*} [result] - Result data
     * @param {string} [error] - Error message
     */
    function sendResponse(id, success, result, error) {
      const response = {
        id,
        type: 'response',
        success,
        result,
        error,
        duration: 0,
      };
      self.postMessage(response);
    }

    /**
     * Handle messages from the main thread.
     * @param {MessageEvent} event
     */
    self.onmessage = async function (event) {
      const { id, type, payload } = event.data;

      try {
        switch (type) {
          case 'inference':
            await handleInference(id, payload);
            break;
          case 'tensorOp':
            await handleTensorOp(id, payload);
            break;
          case 'memoryOp':
            await handleMemoryOp(id, payload);
            break;
          case 'benchmark':
            await handleBenchmark(id, payload);
            break;
          case 'status':
            handleStatus(id);
            break;
          default:
            sendResponse(id, false, null, \`Unknown operation type: \${type}\`);
        }
      } catch (error) {
        sendResponse(id, false, null, error.message || String(error));
      }
    };

    /**
     * Handle inference operations.
     * @param {string} id - Message ID
     * @param {*} payload - Inference payload
     */
    async function handleInference(id, payload) {
      const startTime = performance.now();
      const { modelId, inputData, sessionOptions } = payload || {};

      // Validate input
      if (!inputData) {
        throw new Error('Inference payload must include inputData');
      }

      // Simulate inference processing
      // In production, this would use ONNX Runtime Web or WebNN
      const result = {
        modelId: modelId || 'default',
        outputData: null,
        metadata: {
          inputSize: inputData.length || 0,
          processedAt: Date.now(),
        },
      };

      const duration = performance.now() - startTime;
      sendResponse(id, true, result, null, duration);
    }

    /**
     * Handle tensor operations.
     * @param {string} id - Message ID
     * @param {*} payload - Tensor operation payload
     */
    async function handleTensorOp(id, payload) {
      const startTime = performance.now();
      const { operation, data, shape } = payload || {};

      if (!operation || !data) {
        throw new Error('Tensor operation requires operation and data');
      }

      let result;

      switch (operation) {
        case 'reshape':
          // Reshape tensor data
          result = { data, shape: shape || [data.length] };
          break;
        case 'transpose':
          // Transpose tensor (simplified)
          result = { data: [...data].reverse(), shape };
          break;
        case 'softmax':
          // Apply softmax
          const max = Math.max(...data);
          const exps = data.map(v => Math.exp(v - max));
          const sum = exps.reduce((a, b) => a + b, 0);
          result = { data: exps.map(v => v / sum), shape };
          break;
        default:
          throw new Error(\`Unknown tensor operation: \${operation}\`);
      }

      const duration = performance.now() - startTime;
      sendResponse(id, true, result, null, duration);
    }

    /**
     * Handle memory operations.
     * @param {string} id - Message ID
     * @param {*} payload - Memory operation payload
     */
    async function handleMemoryOp(id, payload) {
      const { operation, key, data } = payload || {};

      switch (operation) {
        case 'store':
          // Store data in worker memory
          if (key && data) {
            self.__workerCache = self.__workerCache || new Map();
            self.__workerCache.set(key, data);
            sendResponse(id, true, { stored: true, key });
          } else {
            throw new Error('Memory store requires key and data');
          }
          break;
        case 'retrieve':
          // Retrieve data from worker memory
          if (key) {
            self.__workerCache = self.__workerCache || new Map();
            const value = self.__workerCache.get(key);
            sendResponse(id, true, { key, data: value });
          } else {
            throw new Error('Memory retrieve requires key');
          }
          break;
        case 'clear':
          // Clear worker memory
          self.__workerCache = self.__workerCache || new Map();
          const count = self.__workerCache.size;
          self.__workerCache.clear();
          sendResponse(id, true, { cleared: true, entriesRemoved: count });
          break;
        default:
          throw new Error(\`Unknown memory operation: \${operation}\`);
      }
    }

    /**
     * Run a simple benchmark to measure worker performance.
     * @param {string} id - Message ID
     * @param {*} payload - Benchmark options
     */
    async function handleBenchmark(id, payload) {
      const startTime = performance.now();
      const iterations = payload?.iterations || 1000;

      // Run a computational benchmark
      let result = 0;
      for (let i = 0; i < iterations; i++) {
        result += Math.sin(i) * Math.cos(i);
      }

      const duration = performance.now() - startTime;
      sendResponse(id, true, {
        iterations,
        result,
        opsPerMs: iterations / duration,
        duration,
      }, null, duration);
    }

    /**
     * Report worker status.
     * @param {string} id - Message ID
     */
    function handleStatus(id) {
      sendResponse(id, true, {
        online: true,
        hasSession: currentSession !== null,
        cacheSize: self.__workerCache ? self.__workerCache.size : 0,
        memoryEstimate: performance.memory ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
        } : null,
      });
    }
  `;

  const blob = new Blob([workerCode], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);

  // Clean up the blob URL when the worker is terminated
  const originalTerminate = worker.terminate.bind(worker);
  worker.terminate = function () {
    URL.revokeObjectURL(url);
    return originalTerminate();
  };

  return worker;
}

/**
 * Create a proxy that wraps a GPU worker with a Promise-based API.
 * Provides a simpler interface for calling GPU operations.
 *
 * @returns {Object} Worker proxy with method-based API
 */
export function createGpuWorkerProxy() {
  const worker = createGpuWorker();
  let messageId = 0;
  const pending = new Map();

  worker.onmessage = (event) => {
    const { id, success, result, error } = event.data;
    const pendingOp = pending.get(id);
    if (pendingOp) {
      pending.delete(id);
      if (success) {
        pendingOp.resolve(result);
      } else {
        pendingOp.reject(new Error(error || 'Unknown worker error'));
      }
    }
  };

  worker.onerror = (event) => {
    // Reject all pending operations on error
    for (const [id, pendingOp] of pending) {
      pendingOp.reject(new Error(`Worker error: ${event.message}`));
      pending.delete(id);
    }
  };

  /**
   * Send a message to the worker and return a promise.
   * @param {string} type - Operation type
   * @param {*} [payload] - Operation payload
   * @returns {Promise<*>}
   */
  function send(type, payload) {
    return new Promise((resolve, reject) => {
      const id = String(++messageId);
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, payload });
    });
  }

  const proxy = {
    /**
     * Run inference with the given input data.
     * @param {*} inputData - Input data for inference
     * @param {Object} [options] - Additional options
     * @returns {Promise<*>}
     */
    inference: (inputData, options = {}) => {
      return send('inference', { inputData, ...options });
    },

    /**
     * Perform a tensor operation.
     * @param {string} operation - Operation name
     * @param {*} data - Tensor data
     * @param {number[]} [shape] - Tensor shape
     * @returns {Promise<*>}
     */
    tensorOp: (operation, data, shape) => {
      return send('tensorOp', { operation, data, shape });
    },

    /**
     * Store data in the worker's memory.
     * @param {string} key - Storage key
     * @param {*} data - Data to store
     * @returns {Promise<*>}
     */
    store: (key, data) => {
      return send('memoryOp', { operation: 'store', key, data });
    },

    /**
     * Retrieve data from the worker's memory.
     * @param {string} key - Storage key
     * @returns {Promise<*>}
     */
    retrieve: (key) => {
      return send('memoryOp', { operation: 'retrieve', key });
    },

    /**
     * Clear the worker's memory cache.
     * @returns {Promise<*>}
     */
    clearMemory: () => {
      return send('memoryOp', { operation: 'clear' });
    },

    /**
     * Run a benchmark.
     * @param {number} [iterations=1000] - Number of iterations
     * @returns {Promise<*>}
     */
    benchmark: (iterations = 1000) => {
      return send('benchmark', { iterations });
    },

    /**
     * Get worker status.
     * @returns {Promise<*>}
     */
    status: () => {
      return send('status');
    },

    /**
     * Terminate the worker.
     */
    terminate: () => {
      for (const [id, pendingOp] of pending) {
        pendingOp.reject(new Error('Worker was terminated'));
        pending.delete(id);
      }
      worker.terminate();
    },
  };

  return proxy;
}

export default {
  createGpuWorker,
  createGpuWorkerProxy,
};