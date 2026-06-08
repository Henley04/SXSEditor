/**
 * 创建延迟初始化包装器，防止重复初始化并缓存 promise
 * @template T
 * @param {() => Promise<T>} factory
 * @returns {{ get: () => Promise<T>, reset: () => void, getInstance: () => T|null }}
 */
function createLazyInitializer(factory) {
  let instance = null;
  let initPromise = null;

  async function get() {
    if (instance) return instance;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        instance = await factory();
        return instance;
      } catch (err) {
        initPromise = null;
        throw err;
      }
    })();
    return initPromise;
  }

  function reset() {
    instance = null;
    initPromise = null;
  }

  function getInstance() {
    return instance;
  }

  return { get, reset, getInstance };
}

module.exports = { createLazyInitializer };
