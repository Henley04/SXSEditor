export const PIANO_KEY_WIDTH = 60;
export const NOTE_HEIGHT = 16;
export const BEAT_WIDTH = 80;
export const HEADER_HEIGHT = 24;
export const F0_CURVE_AREA_HEIGHT = 100;
export const BPM = 120;

// ---------------------------------------------------------------------------
// F0 曲线区域是否折叠
//
// F0 曲线占 100px，短参考音频下会把钢琴卷轴挤得很矮。折叠状态用模块级可变值
// 而不是常量：它被 pianoRoll / canvasRenderer / uiControls 三处布局代码读取，
// 逐层传参会污染一堆函数签名。选择写进 localStorage，编辑与预处理共用同一份。
// ---------------------------------------------------------------------------
const F0_COLLAPSED_STORAGE_KEY = 'sxseditor.preprocess.f0Collapsed';

let _f0AreaHeight = F0_CURVE_AREA_HEIGHT;
try {
  if (typeof localStorage !== 'undefined'
    && localStorage.getItem(F0_COLLAPSED_STORAGE_KEY) === '1') {
    _f0AreaHeight = 0;
  }
} catch (_e) {
  // localStorage 不可用（隐私模式等）时按展开处理
}

/** 当前 F0 曲线区域高度（折叠时为 0）。 */
export function getF0AreaHeight() {
  return _f0AreaHeight;
}

export function isF0AreaCollapsed() {
  return _f0AreaHeight === 0;
}

/**
 * 设置 F0 区域折叠状态。
 * @param {boolean} collapsed
 */
export function setF0AreaCollapsed(collapsed) {
  _f0AreaHeight = collapsed ? 0 : F0_CURVE_AREA_HEIGHT;
  try {
    localStorage.setItem(F0_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch (_e) {
    // 存不下不影响本次会话
  }
}
