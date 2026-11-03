/**
 * 平台判定（渲染层唯一实现）。
 *
 * 为什么单独抽出来：快捷键展示与匹配都要知道"平台主修饰键是 Command 还是
 * Control"，而窗口有 10 个、脚本有好几份。各自抄一遍 `navigator.platform`
 * 的结果必然是"管理器窗口显示 Cmd、主窗口按 Ctrl 匹配"这种只在 mac 上才
 * 暴露的偏差。
 */

/**
 * @param {Navigator} [nav] 便于测试注入
 * @returns {boolean}
 */
export function isMacPlatform(nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (!nav) return false;
  const platform = nav.userAgentData?.platform || nav.platform || '';
  if (/mac/i.test(platform)) return true;
  return /Mac OS X/i.test(nav.userAgent || '');
}

/** 当前窗口是否为 macOS。 */
export const isMac = isMacPlatform();
