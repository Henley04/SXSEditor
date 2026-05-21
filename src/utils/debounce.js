/**
 * 防抖函数
 * @param {Function} fn - 要防抖的函数
 * @param {number} ms - 延迟毫秒数
 * @returns {Function}
 */
function debounce(fn, ms) {
  let timer = null;
  return function(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, ms);
  };
}

module.exports = { debounce };
