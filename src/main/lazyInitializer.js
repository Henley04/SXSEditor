/**
 * 创建延迟初始化包装器，防止重复初始化并缓存 promise
 *
 * 关键设计：generation 计数器防止 reset() 后的"僵尸初始化"回写
 * 场景：pipeline 正在初始化（factory 未完成）时调用 reset()，
 * 旧的 initPromise 完成后不能把旧实例写回 instance，否则 reset 失效。
 * 每次 reset() 递增 generation，init IIFE 在写回前校验 generation 是否变化。
 *
 * @template T
 * @param {() => Promise<T>} factory
 * @returns {{ get: () => Promise<T>, reset: () => void, getInstance: () => T|null }}
 */
function createLazyInitializer(factory) {
  let instance = null;
  let initPromise = null;
  let generation = 0;

  async function get() {
    if (instance) return instance;
    if (initPromise) return initPromise;
    const gen = generation;
    initPromise = (async () => {
      try {
        const result = await factory();
        // 仅当 generation 未变化时才写回，避免被中间的 reset() 作废的初始化覆盖
        if (gen === generation) {
          instance = result;
        }
        return result;
      } catch (err) {
        // 仅当 generation 未变化时才清空 initPromise，避免清掉新一轮的 initPromise
        if (gen === generation) {
          initPromise = null;
        }
        throw err;
      }
    })();
    return initPromise;
  }

  function reset() {
    instance = null;
    initPromise = null;
    generation++;
  }

  function getInstance() {
    return instance;
  }

  return { get, reset, getInstance };
}

module.exports = { createLazyInitializer };
