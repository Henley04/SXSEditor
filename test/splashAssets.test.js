/**
 * Splash 资源守卫 —— 启动画面"构建期烘焙位图 + BaseWindow/ImageView"链上
 * 最容易静默失效的几处。
 *
 * 背景：splash 不走 webpack 渲染入口，也不再有 HTML（直接用主进程的
 * ImageView 画 nativeImage）。位图是**构建期生成的产物**（.gitignore 忽略），
 * 这意味着任何一处漏配都不会在单元测试或 webpack 编译阶段报错，只会表现为
 * "启动画面空白/变形/糊"：
 *
 *   1. CopyPlugin 少拷一张 png → 运行时 readFileSync 失败 → 直接没有启动画面；
 *   2. splashManager 的窗口尺寸与 generate-splash-image.js 的 LOGICAL_W/H
 *      不一致 → ImageView 把图撑满窗口，文字被拉伸变糊；
 *   3. SPLASH_REPS 少了某个倍率 → 对应 DPI 的屏幕只能用别的近似图，白生成；
 *   4. 有人把 splash 改回 BrowserWindow → 渲染进程重新回到启动关键路径上，
 *      ImageView 省下的那 100ms 又还回去了。
 *
 * 这些都是"配置/常量对齐"问题，用源码断言守比跑起来看更可靠。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const SPLASH_GEN = path.join(ROOT, 'scripts', 'generate-splash-image.js');
const SPLASH_MANAGER = path.join(ROOT, 'src', 'main', 'splashManager.js');

const genSource = fs.readFileSync(SPLASH_GEN, 'utf8');
const managerSource = fs.readFileSync(SPLASH_MANAGER, 'utf8');

function genScales() {
  const m = genSource.match(/const SCALES = \[([^\]]+)\]/);
  assert.ok(m, 'generate-splash-image.js 缺失 SCALES 常量');
  return m[1].split(',').map((s) => Number(s.trim()));
}

function managerReps() {
  const block = managerSource.match(/const SPLASH_REPS = \[([\s\S]*?)\];/);
  assert.ok(block, 'splashManager.js 缺失 SPLASH_REPS 常量');
  return [...block[1].matchAll(/scaleFactor:\s*(\d+)/g)].map((m) => Number(m[1]));
}

describe('splash 资源链', () => {
  it('splash 必须走 BaseWindow + ImageView（不允许退回渲染进程）', () => {
    assert.ok(
      /BaseWindow/.test(managerSource) && /new ImageView\(\)/.test(managerSource),
      'splashManager.js 不再使用 BaseWindow + ImageView：那会把渲染进程重新拉回 ' +
        'before-first-paint 路径（BrowserWindow 需要 spawn renderer + 解析 HTML）'
    );
    assert.ok(
      !/new BrowserWindow/.test(managerSource),
      'splashManager.js 里出现了 BrowserWindow：启动画面不应再依赖渲染进程'
    );
    assert.ok(
      !/loadFile|loadURL/.test(managerSource),
      'splashManager.js 仍在加载 HTML/URL：ImageView 方案不需要任何文档'
    );
  });

  it('ImageView 是实验 API，必须有缺失时的降级分支', () => {
    assert.ok(
      /typeof ImageView !== 'function'/.test(managerSource),
      '缺少 ImageView 能力检测：Experimental API 一旦被移除，启动会直接抛错'
    );
  });

  it('SPLASH_REPS 必须覆盖生成器输出的每个倍率', () => {
    const scales = genScales();
    const reps = managerReps();
    assert.ok(scales.length >= 1, '生成器没有输出任何倍率');
    for (const s of scales) {
      assert.ok(
        reps.includes(s),
        `生成器输出 ${s}x，但 splashManager 的 SPLASH_REPS 没登记：` +
          `${s}x 屏会退到别的近似图`
      );
    }
    assert.ok(
      reps.includes(2),
      'SPLASH_REPS 缺少 2x：1x/1.25x 屏没有可下采样的图'
    );
  });

  it('CopyPlugin 必须把每张倍率图都拷到 .webpack/main', () => {
    const webpackMain = require(path.join(ROOT, 'webpack.main.config.js'));
    const configs = Array.isArray(webpackMain) ? webpackMain : [webpackMain];

    const copied = [];
    for (const cfg of configs) {
      for (const plugin of cfg.plugins || []) {
        const patterns = plugin?.patterns || plugin?.options?.patterns;
        if (!Array.isArray(patterns)) continue;
        for (const p of patterns) {
          const from = typeof p === 'string' ? p : p.from;
          const to = typeof p === 'string' ? null : p.to;
          if (typeof from === 'string') copied.push({ from, to });
        }
      }
    }

    for (const scale of genScales()) {
      const name = `splash@${scale}x.png`;
      const hit = copied.find((c) => c.from.endsWith(path.join('src', name)));
      assert.ok(
        hit,
        `webpack.main.config.js 的 CopyPlugin 没有拷贝 src/${name}：` +
          '打包后 .webpack/main 里缺这张图，对应 DPI 的启动画面会退化成无图'
      );
      assert.ok(
        hit.to && hit.to.endsWith(path.join('.webpack', 'main', name)),
        `src/${name} 的拷贝目标不是 .webpack/main/${name}`
      );
    }
  });

  it('窗口尺寸必须等于位图的逻辑尺寸（否则 ImageView 会拉伸）', () => {
    const w = Number((genSource.match(/const LOGICAL_W = (\d+)/) || [])[1]);
    const h = Number((genSource.match(/const LOGICAL_H = (\d+)/) || [])[1]);
    assert.ok(w > 0 && h > 0, 'generate-splash-image.js 缺少 LOGICAL_W/H');

    const winW = Number((managerSource.match(/const SPLASH_WIDTH = (\d+)/) || [])[1]);
    const winH = Number((managerSource.match(/const SPLASH_HEIGHT = (\d+)/) || [])[1]);
    assert.ok(winW > 0 && winH > 0, 'splashManager.js 缺少 SPLASH_WIDTH/HEIGHT');

    assert.strictEqual(
      winW,
      w,
      `窗口宽 ${winW} ≠ 位图逻辑宽 ${w}：ImageView 会把图撑满窗口，横向被拉伸`
    );
    assert.strictEqual(
      winH,
      h,
      `窗口高 ${winH} ≠ 位图逻辑高 ${h}：ImageView 会把图撑满窗口，纵向被拉伸`
    );
  });

  it('verify-build-assets 必须校验 splash 生成器', () => {
    const verify = fs.readFileSync(
      path.join(ROOT, 'scripts', 'verify-build-assets.js'),
      'utf8'
    );
    assert.ok(
      /REQUIRED_SPLASH_ASSETS[\s\S]*generate-splash-image\.js/.test(verify),
      'verify-build-assets.js 没有校验生成器脚本存在：' +
        'CopyPlugin 带 noErrorOnMissing，缺图只会静默跳过'
    );
  });
});
