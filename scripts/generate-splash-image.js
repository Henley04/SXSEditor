#!/usr/bin/env node
/**
 * generate-splash-image.js —— 把启动画面烘焙成位图，构建期运行。
 *
 * 为什么要"烘焙成图片"而不是继续用内联 SVG + <text>：
 *   SVG 里的 <text> 要等 HTML 解析完、字体匹配（fallback 链逐个查表）、字形
 *   shaping 与栅格化跑完才会出现，正是启动画面"先白一下、再跳字"的来源。
 *   位图没有这些依赖：PNG 解码完即可上屏，也不会出现"字体未就绪时先闪一帧
 *   回退字体"。
 *
 * 为什么在构建期生成（而不是运行时）：
 *   图片里要写构建时间和版本号 —— 这两个值随每次构建而变，只能在
 *   prepackage / prestart 阶段算出来后烘焙进像素。CI 与本地
 *   `npm run package:lite` 走同一条链（generate-build-info.js 调用本脚本），
 *   两边产出完全一致，不存在"CI 有图、本地空白"的分叉。
 *
 * 为什么要两套倍率（2x / 3x）而不是一张超高倍图：
 *   位图的清晰度取决于"源像素 : 物理像素"是否接近 1:1，不是源图越大越好。
 *   一张 4x 图在 1x 屏上要缩 4 倍，滤波窗口宽、笔画边缘被抹成 4px 过渡，
 *   观感反而发虚；而 2x 图在 2x 屏上是 1:1，每个物理像素都有源像素。
 *   所以按 devicePixelRatio 出 2x（960×544）与 3x（1440×816）两版，由
 *   splashManager 作为同一个 nativeImage 的两个 representation 挂上去，
 *   Electron 各取所需：
 *     1x / 1.25x 屏 → 2x 图（下采样 1.6–2 倍，锐利）
 *     1.5x / 2x 屏  → 2x 图（1:1 或轻微下采样）
 *     2.5x / 3x 屏  → 3x 图（1:1）
 *
 * 依赖：@napi-rs/canvas（devDependency，仅构建期使用，不进安装包）。
 *
 * 用法：node scripts/generate-splash-image.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INFO_PATH = path.join(ROOT, 'src', 'build-info.json');
const SRC_DIR = path.join(ROOT, 'src');

// 必须与 src/main/splashManager.js 里 BaseWindow 的 SPLASH_WIDTH/HEIGHT 一致，
// 否则 ImageView 会把图撑满窗口，文字被拉伸。
const LOGICAL_W = 480;
const LOGICAL_H = 272;

// 输出倍率。1x 不单独出图：1x 屏直接用 2x 图下采样，比 1x 位图更平滑，
// 也少一个文件。
const SCALES = [2, 3];

const RADIUS = 14; // 窗口圆角（逻辑像素）

// 卡片整体的不透明度（0.86）。为什么烘焙进 alpha 而不是交给窗口：
//   ImageView / View 没有 opacity API，BaseWindow 只有构造期 `opacity` ——
//   而它在 Windows 上走 SetLayeredWindowAttributes，与 transparent 窗口用的
//   per-pixel alpha（UpdateLayeredWindow）互斥，行为不可靠。所以透明度只能
//   落在像素里；Bayer 抖动（见 dither）负责把由此产生的 1 级量化台阶打散。
const CARD_ALPHA = 0.86;

// Segoe UI 在 Windows 10/11（本地 + GitHub 的 windows-latest）上必定存在；
// 其余是给 macOS / Linux 打包用的回退，字形宽度略有差异但版式不会溢出。
const FONT_STACK =
  '"Segoe UI", "Segoe UI Variable Display", -apple-system, BlinkMacSystemFont, ' +
  '"Helvetica Neue", Arial, "DejaVu Sans", "Liberation Sans", sans-serif';

// 浅色磨砂玻璃 + 近黑字。文字用满不透明度，卡片整体再乘 CARD_ALPHA
// （见 applyCardAlpha）。
const COLOR_TITLE = '#131319';
const COLOR_SUBTITLE = '#1c1c24';
const COLOR_BODY = '#33333f';
const COLOR_FOOTER = '#3f3f4a';

function splashFileName(scale) {
  return `splash@${scale}x.png`;
}

function readBuildInfo() {
  if (!fs.existsSync(INFO_PATH)) {
    throw new Error(
      `[splash-image] 找不到 ${path.relative(ROOT, INFO_PATH)}；` +
        '它由 scripts/generate-build-info.js 在本脚本之前写出。'
    );
  }
  return JSON.parse(fs.readFileSync(INFO_PATH, 'utf8'));
}

// @napi-rs/canvas 是 devDependency（构建期用，不进安装包）。惰性加载 + 明确
// 报错文案，避免缺依赖时抛一句看不懂的 MODULE_NOT_FOUND。
let _canvasLib = null;
function getCanvasLib() {
  if (_canvasLib) return _canvasLib;
  try {
    _canvasLib = require('@napi-rs/canvas');
  } catch (err) {
    throw new Error(
      '[splash-image] 无法加载 @napi-rs/canvas（构建期依赖）。' +
        '请在仓库根目录执行 `npm install` 后再构建。原始错误：' + err.message
    );
  }
  return _canvasLib;
}

/** 圆角矩形路径（Skia 的 arcTo 与 Canvas2D 语义一致）。 */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * 亚克力背景 —— 一张**完全不透明**的"磨砂玻璃配色图"，只负责颜色；
 * 整体的半透明度在最后一步由 applyCardAlpha() 一次性乘进 alpha 通道。
 *
 * 为什么是"先画不透明、最后统一乘 alpha"，而不是边画边用半透明色：
 *   8 位 alpha 只有 256 级。若让每一层渐变各自带 alpha，叠加出来的合成
 *   alpha 会在半径收口处出现几十像素宽的台阶（Mach band）—— 第一版右侧
 *   那两道弧形色带就是这么来的。
 *   现在渐变只发生在 RGB 通道（连续 15 级，浅色区相邻一级远低于人眼阈值），
 *   alpha 全程是 255，最后乘一个常数 0.86，整个平面只有"圆角外 0 /
 *   内部约 219"两种值，压缩率也最好。
 *
 * 视觉构成（只改 RGB）：
 *   1. 135° 基底：偏冷的白 → 很淡的灰蓝（只是"偏冷的白"，不是蓝）；
 *   2. 左上角高光：光源方向，让左上比右下亮约 4%，弱到说不出颜色；
 *   3. 右下角冷色晕：饱和度压到 ~10%，配合高透明度在视觉上接近中性。
 */
function buildAcrylicBackground(scale) {
  const { createCanvas } = getCanvasLib();
  const bg = createCanvas(LOGICAL_W * scale, LOGICAL_H * scale);
  const ctx = bg.getContext('2d');
  ctx.scale(scale, scale);

  const base = ctx.createLinearGradient(0, 0, LOGICAL_W, LOGICAL_H);
  base.addColorStop(0, '#f6f8fd');
  base.addColorStop(0.55, '#eef2fb');
  base.addColorStop(1, '#e7ebf8');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  // 左上高光。半径必须覆盖到画布最远角（否则 radial 的收口边界会变成画布内
  // 一条肉眼可见的圆弧 —— 第一版就是这样翻车的），圆心再放到画布外。
  const glow = ctx.createRadialGradient(
    LOGICAL_W * 0.10, -LOGICAL_H * 0.12, 0,
    LOGICAL_W * 0.10, -LOGICAL_H * 0.12, LOGICAL_W * 1.35
  );
  glow.addColorStop(0, 'rgba(255, 255, 255, 0.78)');
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  // 右下冷色晕，同样保证收口在画布之外。
  const tint = ctx.createRadialGradient(
    LOGICAL_W * 1.05, LOGICAL_H * 1.10, 0,
    LOGICAL_W * 1.05, LOGICAL_H * 1.10, LOGICAL_W * 1.52
  );
  tint.addColorStop(0, 'rgba(172, 186, 230, 0.24)');
  tint.addColorStop(1, 'rgba(172, 186, 230, 0)');
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  dither(bg);
  return bg;
}

/**
 * 抖动（dither）。
 *
 * 8 位色深下，一段跨 15 级的 RGB 渐变铺满整张卡片，每级台阶有几十像素宽 ——
 * 即便每级只差 1/255，人眼在均匀色块上仍能看出边界（Mach band），表现为
 * 一层层斜向或弧形的"色带"。这不是渐变画错了，是量化的固有现象。
 *
 * 解法是在量化之前加一点零均值偏移，把台阶边界打散。这里用**有序抖动**
 * （8×8 Bayer 矩阵）而不是随机噪声：两者视觉效果相当（幅度只有 1 级左右，
 * 远看都是均色），但 Bayer 图案每 8 像素重复一次，PNG 的预测滤波能吃掉
 * 绝大部分冗余 —— 实测随机噪声会把 2x 图从 140 KiB 顶到 1 MiB 以上，Bayer
 * 只多几十 KiB。这个尺寸差异直接决定启动时读盘 + 解码的时间。
 */
const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

function dither(target) {
  const ctx = target.getContext('2d');
  const w = target.width;
  const h = target.height;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let i = 0;
  for (let y = 0; y < h; y++) {
    const by = (y & 7) << 3;
    for (let x = 0; x < w; x++) {
      // (-0.5, 0.5) 的阈值偏移，乘以幅度即为该像素的亮度微调。
      const n = ((BAYER8[by + (x & 7)] + 0.5) / 64 - 0.5) * 1.8;
      const r = d[i] + n;
      const g = d[i + 1] + n;
      const b = d[i + 2] + n;
      d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      i += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * 圆角边缘的两道描边：
 *   · 内侧 1px 白（alpha 0.55）—— 玻璃边缘的镜面高光；
 *   · 外侧 1px 近黑（alpha 0.10）—— 让卡片在白色桌面上也有可辨识的轮廓。
 * 两道都沿圆角路径走，圆角外的像素保持 alpha=0（透明窗口靠它出圆角）。
 */
function drawEdge(ctx) {
  ctx.save();
  roundRectPath(ctx, 0.5, 0.5, LOGICAL_W - 1, LOGICAL_H - 1, RADIUS - 0.5);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.stroke();

  roundRectPath(ctx, 0, 0, LOGICAL_W, LOGICAL_H, RADIUS);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(16, 18, 28, 0.10)';
  ctx.stroke();
  ctx.restore();
}

function setFont(ctx, weight, size) {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

/**
 * 版式（逻辑像素，左上原点）：
 *
 *   SXSEditor                                    ← 32px / 700，基线 60
 *   An AI-Powered SVS Product                    ← 18px / 600，基线 88
 *   Build Date: 26/10/18. 20:54:56(UTC+8)        ← 14px / 400，基线 110
 *   Version 1.2.3 (Nightly)                      ← 14px / 400，基线 128
 *   Loading...                                   ← 14px / 400，基线 151
 *
 *   Copyright Henley04 2026. MIT License.        ← 12.5px / 400，基线 250
 *
 * 左边界 28，与窗口的视觉留白对齐；版权单独压在底部（距下沿 22px）。
 */
function drawText(ctx, info) {
  const LEFT = 28;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  setFont(ctx, 700, 32);
  ctx.fillStyle = COLOR_TITLE;
  ctx.fillText('SXSEditor', LEFT, 60);

  setFont(ctx, 600, 18);
  ctx.fillStyle = COLOR_SUBTITLE;
  ctx.fillText('An AI-Powered SVS Product', LEFT, 88);

  setFont(ctx, 400, 14);
  ctx.fillStyle = COLOR_BODY;
  ctx.fillText(`Build Date: ${info.buildDateDisplay}(${info.utcOffset})`, LEFT, 110);
  ctx.fillText(`Version ${info.version} (${info.channel})`, LEFT, 128);
  ctx.fillText('Loading...', LEFT, 151);

  setFont(ctx, 400, 12.5);
  ctx.fillStyle = COLOR_FOOTER;
  ctx.fillText(`Copyright Henley04 ${info.buildYear}. MIT License.`, LEFT, 250);
}

/**
 * 把整张卡片的 alpha 统一乘上 CARD_ALPHA。
 *
 * 只改 alpha 通道、不动 RGB —— 等价于"把一张不透明图层以 86% 不透明度合成"，
 * 但省掉了图层合成那条路上的预乘/反乘往返（那正是把浅色渐变压成宽台阶的
 * 元凶）。圆角外 alpha=0 保持不变；圆角抗锯齿边缘按比例缩小，过渡依旧平滑。
 */
function applyCardAlpha(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    if (a === 0) continue;
    d[i] = Math.round(a * CARD_ALPHA);
  }
  ctx.putImageData(img, 0, 0);
}

function renderAtScale(scale, info) {
  const { createCanvas } = getCanvasLib();
  const canvas = createCanvas(LOGICAL_W * scale, LOGICAL_H * scale);
  const ctx = canvas.getContext('2d');

  // 全部按逻辑坐标绘制，由变换统一放大 —— Skia 在放大后的坐标系里做字形
  // 栅格化，所以文字是真正的 N 倍分辨率，不是"先画小再拉大"。
  ctx.scale(scale, scale);

  const acrylic = buildAcrylicBackground(scale);

  ctx.save();
  roundRectPath(ctx, 0, 0, LOGICAL_W, LOGICAL_H, RADIUS);
  ctx.clip();
  // 不透明铺底；整卡透明度在最后统一施加（见 applyCardAlpha）。
  // 圆角外保持 alpha=0，透明窗口靠它出圆角。
  ctx.drawImage(acrylic, 0, 0, LOGICAL_W, LOGICAL_H);
  drawText(ctx, info);
  ctx.restore();

  drawEdge(ctx);
  applyCardAlpha(canvas);

  const outPath = path.join(SRC_DIR, splashFileName(scale));
  const png = canvas.toBuffer('image/png');
  fs.writeFileSync(outPath, png);
  console.log(
    `[splash-image] wrote ${path.relative(ROOT, outPath)} ` +
      `(${canvas.width}×${canvas.height}, ${(png.length / 1024).toFixed(1)} KiB)`
  );
  return outPath;
}

function generate() {
  const info = readBuildInfo();

  // 清掉历史遗留的单张 splash.png（旧方案 4x 单图），避免被打进包却没人引用。
  const legacy = path.join(SRC_DIR, 'splash.png');
  if (fs.existsSync(legacy)) fs.rmSync(legacy);

  const written = SCALES.map((scale) => renderAtScale(scale, info));
  console.log(
    `[splash-image] version=${info.version} channel=${info.channel} ` +
      `build=${info.buildDateDisplay}(${info.utcOffset})`
  );
  return written;
}

module.exports = { generate, LOGICAL_W, LOGICAL_H, SCALES, splashFileName };

if (require.main === module) {
  generate();
}
