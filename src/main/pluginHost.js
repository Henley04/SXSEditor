/**
 * 歌声后端插件宿主（主进程侧）。
 *
 * ## 执行环境：默认 worker，in-process 需要显式 opt-in
 *
 * 插件有两个执行模式（`request.manifest.executionMode`）：
 *
 *   1. `'worker'`（**默认**）：插件跑在 `node:worker_threads` 里（入口脚本
 *      `./pluginWorker.js`）。好处是**超时真的能抢占** —— 插件同步忙等 / 死循环
 *      时，超时到期直接 `worker.terminate()`（实测对一个忙等中的 worker 调用
 *      terminate 只需 ~5ms），主进程与其它窗口不受影响。
 *   2. `'inprocess'`：插件以 CommonJS `require()` 直载进主进程。好处是
 *      `request.options` 与调用方手上的对象真的是**同一个引用**（零编码开销，
 *      所有标量 / 深层结构原样可见）。
 *
 * ### ⚠️ 诚实的边界：in-process 模式下的同步阻塞**无法被抢占**
 *
 * `withTimeout()` 的 `Promise.race + setTimeout` 只对"插件异步不返回"有用：
 * 一旦插件执行同步忙等 / 死循环，主进程事件循环本身被占死，定时器排不上队，
 * 超时回调永远不会触发，窗口也会一起冻结。**这是 Node 单线程语义决定的，
 * 进程内没有任何办法中断一段同步执行**（`worker.terminate()` 之所以有效，是因为
 * 目标代码在另一个线程里，由 V8 的终止请求打断）。
 * 因此 `'inprocess'` 只是给"必须拿同一对象引用、且作者自证不会长时间同步阻塞"
 * 的插件留的逃生口，需要 host 白名单放行并记录告警，绝不能拿来当默认值。
 *
 * ### worker 模式下的 observable 差异（必须知道）
 *
 *   · 请求里的 TypedArray（refAudioWavBuffer / pitchCurveF0 / refF0Data /
 *     scratch）会**转移所有权**（transfer list，零拷贝）：调用方手上的原数组在
 *     调用后会变成 detached（byteLength === 0），不能重复用于第二次调用；
 *     多个插件分片共享同一份底层数据时，调用方必须先自己按分片切片复制。
 *   · 请求里的函数（options.onProgress / onChunkAudio / refF0Extractor 等）
 *     无法跨线程搬运，插件侧拿到的是同名代理，调用它会被转发回主进程执行
 *     （`await` 才能拿到返回值）。
 *   · `host.*` 在插件侧是代理：返回值不代表主进程的处理结果（跨线程拿不到同步
 *     返回值），节流 / ticket / IPC 推送仍然在主进程完成。
 *
 * ## 无论哪个模式都生效的护栏
 *
 *   1. 生命周期护栏：initialize 成功后才允许 synthesize，dispose 后一律拒绝；
 *   2. 调用超时（worker 模式真抢占 / in-process 模式退化为异步超时）；
 *   3. 异常隔离：插件抛错只记 sanitize 后的信息，不让宿主线程崩掉；
 *   4. 结果校验：pcm 类型 / 有限值 / 长度上限 / sampleRate 越界一律拒绝，
 *      避免脏数据污染混音链路；
 *   5. 路径护栏：插件目录先 authorizePath() 授权，入口文件必须落在插件目录内
 *      （realpath 后比较，挡掉 `..`、绝对路径与符号链接逃逸）；
 *   6. 输出节流：`plugin:progress`（50ms）与 `plugin:blocking-update`
 *      （100ms + 2% 变化阈值，与 svsIpc 的进度节流同一套风格）。
 *
 * ## 可注入性
 *
 * `createPluginHost({ pluginsDir, ... })` 的 pluginsDir 默认走
 * `app.getPath('userData')/plugins`，但可以注入——纯 Node 单测（没有 electron）
 * 与打包后的自定义插件目录都依赖这一点。
 */

const path = require('node:path');
const fs = require('node:fs');
const contract = require('../shared/pluginContract.js');
// A1: 权限声明/模块分类（CJS，与主进程和 worker 的 require 路径都兼容）
const permissionsContract = require('../shared/pluginPermissions.js');
const wire = require('./pluginWorker.js');

/**
 * worker 模式的执行环境脚本——按候选路径逐个探测。
 *
 * 原因是源码运行与打包运行的目录布局不同：
 *   - 源码运行：`__dirname` 是 `src/main/`，脚本就在旁边；
 *   - 打包运行：webpack 只把 `src/main.js` 打成 `.webpack/main/index.js`，
 *     而 `src/main/` 整个目录由 CopyPlugin 原样拷到 `.webpack/main/main/`
 *     （见 webpack.main.config.js），此时 `__dirname` 是 `.webpack/main/`。
 * 只写 `path.join(__dirname, 'pluginWorker.js')` 会让打包版永远 ENOENT，
 * 插件功能整体不可用，所以这里必须探测而不是硬编码。
 */
const WORKER_ENTRY_CANDIDATES = [
  path.join(__dirname, 'pluginWorker.js'),          // 源码运行
  path.join(__dirname, 'main', 'pluginWorker.js'),  // 打包运行
];

/** @returns {string|null} 第一个真实存在的 worker 入口；都不存在时返回 null。 */
function resolveWorkerEntry() {
  for (const candidate of WORKER_ENTRY_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      // 权限/路径异常不算数，继续试下一个候选
    }
  }
  return null;
}

/** 执行模式；'worker' 是唯一安全默认值。 */
const EXECUTION_MODES = ['worker', 'inprocess'];
const DEFAULT_EXECUTION_MODE = 'worker';

/** 合理采样率区间：低于 8k 无法听辨，高于 768k 基本不可能是真实后端输出。 */
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 768000;
const DEFAULT_SAMPLE_RATE = 44100;

/**
 * 单次合成允许返回的最长音频（每声道）。1 小时 ≈ 635MB(44100Hz mono float32)，
 * 已是分块编辑器里一个"片段"的长度上限的天花板；更长的工程应当拆片段合成，
 * streaming 插件也应改用 host.emitAudio 分片推送而不是攒一条超长数组。
 */
const MAX_PCM_DURATION_SEC = 3600;

/**
 * 单次结果允许占用的**总字节数**（所有声道合计，`elements * 4`）。
 * 256MiB ≈ 44100Hz 单声道 25 分钟：再大就会被 IPC 结构化克隆 + 混音分配
 * 同时放大成数倍峰值内存，足以把主进程推到 OOM（审计员实测放行 512MB 的
 * 返回值正是这里没有护栏）。
 */
const MAX_PCM_BYTES = 256 * 1024 * 1024;

/**
 * 有限值扫描的成本上限：超过这个长度的数组不再全量掃描。
 * 全量扫描本身是 O(n) 的，实测 1M float ≈ 1ms（见验证脚本），远小于一次合成
 * 的毫秒级~秒级耗时，因此对常见长度一律全量扫描（**不抽样**——抽样会让单个
 * NaN 逃过检查进而污染整段导出，这是不可接受的正确性损失）。
 */
const FINITE_SCAN_WARN_ELEMENTS = 8 * 1024 * 1024;

/** 阻滞 ticket 的兜底寿命：插件忘记 end() 时最多把 UI 挂这么久。 */
const TICKET_WATCHDOG_MS = 10 * 60 * 1000;

/** 进度推送节流间隔（毫秒）；0/100 与首次回调不受节流限制。 */
const PROGRESS_THROTTLE_MS = 50;

/**
 * ticket.update 的推送节流：100ms + 2% 变化阈值，与 svsIpc 的进度推送同一套
 * 参数。实测 400 音符会因为逐音符 update 触发 400+ 次 `plugin:blocking-update`
 * IPC（其中大部分 UI 根本来不及渲染），节流后降到个位数。
 */
const TICKET_UPDATE_THROTTLE_MS = 100;
const TICKET_UPDATE_PROGRESS_EPSILON = 2;

/** 单个插件最多允许同时挂着的阻滞 ticket 数，防止插件刷爆 UI。 */
const MAX_TICKETS_PER_CALL = 8;

/**
 * 连续超时達到这个次数后把插件标记为不可用 —— worker 会被 terminate 后重新
 * 拉起（一次超时可能只是用户把超时调小了），但持续卡死的插件不应该无限次
 * 重新拉起，需要 reload 才能恢复。
 */
const MAX_CONSECUTIVE_TIMEOUTS = 3;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * 默认日志出口：统一 `[plugins]` 前缀，便于 crashReporter 的会话日志检索。
 * @param {string} level
 * @param {string} scope 形如 `example-concat`
 * @param {string} message
 */
function defaultLogSink(level, scope, message) {
  const line = `[plugins]${scope ? ' [' + scope + ']' : ''} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * 默认插件根目录：<userData>/plugins。
 * 只在调用方未注入 pluginsDir 时才 require('electron')，保证纯 Node 可用。
 */
function defaultPluginsDir() {
  // eslint-disable-next-line global-require
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'plugins');
}

/** 宿主版本（传给插件 ctx.hostVersion）。 */
function defaultHostVersion() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    const v = app.getVersion();
    return typeof v === 'string' && v ? v : '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

/** ctx.getSetting() 的默认实现：读主进程设置（失败返回 undefined）。 */
function defaultGetSetting(key) {
  try {
    // eslint-disable-next-line global-require
    const { loadSettings } = require('./settings');
    const settings = loadSettings();
    return settings ? settings[key] : undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * 把插件侧的错误收敛成一句可展示的话：只留 message，不展开堆栈。
 * @param {unknown} err
 */
function describeError(err) {
  if (!err) return 'unknown plugin error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name;
  if (typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

/**
 * 把错误整理成可返回给渲染进程的错误码 + 脱敏信息。
 * 绝对路径不在这里脱敏（IPC 层 safeHandle 已统一处理），但堆栈一律不带上。
 * @param {unknown} err
 * @param {string} code
 */
function toPluginError(err, code) {
  return {
    code: code || 'PLUGIN_ERROR',
    message: describeError(err),
  };
}

/**
 * Promise.race 超时包装：插件挂死时不要把主进程的合成锁一起挂住。
 * 注意这里**不做**定时器 unref —— 超时必须真的能触发。
 * @template T
 * @param {Promise<T>|T} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`插件调用超时：${label} 超过 ${ms}ms 未返回`));
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * realpath（失败返回 null）。用于挡掉符号链接逃逸。
 * @param {string} p
 */
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return null;
  }
}

/**
 * child 是否位于 base 之内（含相等）。两者都必须是已 realpath 的绝对路径。
 * @param {string} base
 * @param {string} child
 */
function isInside(base, child) {
  if (!base || !child) return false;
  if (child === base) return true;
  const rel = path.relative(base, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * A1：插件 worker 的资源上限。
 *
 * worker_threads 与宿主共享进程地址空间（每个线程有独立 isolate，但共享进程
 * 的句柄表与原生内存），所以插件线程里的无限递归 / 泄漏照样能拖垮应用。这里
 * 给 V8 堆设上限：超限时 worker 会以 'err_oom' 退出并被宿主捕获成一条插件错误，
 * 而不是把主进程一起带走。
 */
const PLUGIN_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 64,
  // 插件常做深度递归（音素树/序列化），默认 984KB 的栈不够；给到 4MB
  stackSizeMb: 4,
});

/**
 * 读取并解析 manifest.json。
 * @param {string} manifestPath
 */
function readManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest.json 不是合法 JSON：${describeError(err)}`);
  }
}

/**
 * 校验 manifest 并规范化出宿主内部使用的描述对象。
 * @param {unknown} manifest
 * @param {string} dirName 插件目录名，必须与 manifest.id 一致
 * @returns {{ok:true, value:object}|{ok:false, error:string}}
 */
function validateManifest(manifest, dirName) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'manifest.json 必须是一个 JSON 对象' };
  }

  const id = manifest.id;
  if (!contract.isValidPluginId(id)) {
    return { ok: false, error: `manifest.id 非法（需小写反向域名风格且不为 builtin/sxs）：${JSON.stringify(id)}` };
  }
  // 目录名即 id：加载路径以目录名为准，避免 manifest 声明 A 而实际装在 B 目录
  // 造成的"两套 id"（授权、日志、require 缓存清理全部会错乱）。
  if (id !== dirName) {
    return { ok: false, error: `manifest.id('${id}') 与插件目录名('${dirName}') 不一致` };
  }
  if (manifest.apiVersion !== contract.PLUGIN_API_VERSION) {
    return { ok: false, error: `apiVersion 不兼容：宿主要求 ${contract.PLUGIN_API_VERSION}，插件声明 ${JSON.stringify(manifest.apiVersion)}` };
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    return { ok: false, error: 'manifest.name 必填' };
  }
  if (!contract.isValidVersion(manifest.version)) {
    return { ok: false, error: `manifest.version 非法（需 x.y.z）：${JSON.stringify(manifest.version)}` };
  }
  if (typeof manifest.main !== 'string' || !manifest.main.trim()) {
    return { ok: false, error: 'manifest.main 必填（相对插件目录的入口 js）' };
  }
  if (manifest.main.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(manifest.main)) {
    return { ok: false, error: `manifest.main 必须是相对路径：${manifest.main}` };
  }

  // executionMode：'worker'（缺省，默认）/ 'inprocess'（插件显式 opt-in 且仍需
  // 宿主白名单放行）。写法非法直接拒绝 —— 跑错模式是安全性质的事，不能静默纠正。
  if (manifest.executionMode !== undefined && !EXECUTION_MODES.includes(manifest.executionMode)) {
    return {
      ok: false,
      error: `manifest.executionMode 非法（只能是 ${EXECUTION_MODES.join(' / ')}）：${JSON.stringify(manifest.executionMode)}`,
    };
  }

  // trackKinds 可选（模块导出里也可以声明），但一旦给了就必须合法且有上限
  let trackKinds = [];
  if (manifest.trackKinds !== undefined) {
    if (!Array.isArray(manifest.trackKinds)) {
      return { ok: false, error: 'manifest.trackKinds 必须是数组' };
    }
    if (manifest.trackKinds.length > contract.PLUGIN_MAX_TRACK_KINDS) {
      return { ok: false, error: `trackKinds 数量超过上限 ${contract.PLUGIN_MAX_TRACK_KINDS}` };
    }
    for (const kind of manifest.trackKinds) {
      const checked = contract.validateTrackKind(kind, id);
      if (!checked.ok) return { ok: false, error: checked.error };
      trackKinds.push(checked.value);
    }
  }

  // A1: 可选的权限声明。给了就必须合法；没给则不启用 require 拦截（兼容存量插件）。
  const perms = permissionsContract.validatePermissions(manifest.permissions);
  if (!perms.ok) return { ok: false, error: perms.error };

  return {
    ok: true,
    value: {
      id,
      name: manifest.name.trim(),
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      main: manifest.main.trim(),
      description: typeof manifest.description === 'string' ? manifest.description : '',
      author: typeof manifest.author === 'string' ? manifest.author : '',
      capabilities: contract.normalizeCapabilities(manifest.capabilities),
      trackKinds,
      // 执行模式缺省 'worker'；'inprocess' 还要过 decideExecutionMode 的白名单
      executionMode: manifest.executionMode === 'inprocess' ? 'inprocess' : DEFAULT_EXECUTION_MODE,
      permissions: perms.value,
    },
  };
}

/**
 * 校验插件入口模块的导出对象（契约 v1）。
 * @param {unknown} mod
 * @param {object} manifestValue 已校验的 manifest
 * @returns {{ok:true, value:object}|{ok:false, error:string}}
 */
function validateModule(mod, manifestValue) {
  if (!mod || typeof mod !== 'object') {
    return { ok: false, error: '入口模块必须导出一个对象（module.exports = {...}）' };
  }
  if (mod.apiVersion !== undefined && mod.apiVersion !== contract.PLUGIN_API_VERSION) {
    return { ok: false, error: `模块导出的 apiVersion 不兼容：${JSON.stringify(mod.apiVersion)}` };
  }
  if (mod.id !== undefined && mod.id !== manifestValue.id) {
    return { ok: false, error: `模块导出的 id('${mod.id}') 与 manifest.id('${manifestValue.id}') 不一致` };
  }

  const capabilities = { ...manifestValue.capabilities };
  if (capabilities.synthesize && typeof mod.synthesize !== 'function') {
    return { ok: false, error: 'capabilities.synthesize=true 但模块没有导出 synthesize()' };
  }
  // getVoices 缺失只降级不拒绝：插件仍可作为合成后端使用，UI 不显示音色列表即可。
  if (capabilities.voices && typeof mod.getVoices !== 'function') {
    capabilities.voices = false;
    console.warn(`[plugins] [${manifestValue.id}] capabilities.voices=true 但没有 getVoices()，已降级为 false`);
  }
  if (!capabilities.synthesize && typeof mod.synthesize !== 'function') {
    // 纯音色/纯面板插件：允许存在，只是不能当合成后端。
    console.warn(`[plugins] [${manifestValue.id}] 未声明 synthesize 能力，将不会作为合成后端`);
  }
  if (mod.initialize !== undefined && typeof mod.initialize !== 'function') {
    return { ok: false, error: 'initialize 必须是函数' };
  }
  if (mod.dispose !== undefined && typeof mod.dispose !== 'function') {
    return { ok: false, error: 'dispose 必须是函数' };
  }

  // 模块导出的 trackKinds 优先于 manifest 的声明（模块是运行时真源）。
  // 但 paramSchema / defaults 若模块没声明，就继承 manifest 的同 id 条目 ——
  // 否则"模块覆盖 trackKinds"会静默丢掉 schema，导致 request.params 全被过滤。
  let trackKinds = manifestValue.trackKinds;
  if (Array.isArray(mod.trackKinds)) {
    if (mod.trackKinds.length > contract.PLUGIN_MAX_TRACK_KINDS) {
      return { ok: false, error: `模块导出的 trackKinds 数量超过上限 ${contract.PLUGIN_MAX_TRACK_KINDS}` };
    }
    const manifestKinds = new Map(manifestValue.trackKinds.map((k) => [k.id, k]));
    const parsed = [];
    for (const kind of mod.trackKinds) {
      const base = manifestKinds.get(kind && kind.id);
      let merged = kind;
      if (base && kind && kind.paramSchema === undefined && base.paramSchema.length > 0) {
        merged = {
          ...kind,
          paramSchema: base.paramSchema,
          defaults: kind.defaults !== undefined ? kind.defaults : base.defaults,
        };
      }
      const checked = contract.validateTrackKind(merged, manifestValue.id);
      if (!checked.ok) return { ok: false, error: checked.error };
      parsed.push(checked.value);
    }
    trackKinds = parsed;
  }

  return {
    ok: true,
    value: {
      id: manifestValue.id,
      name: typeof mod.name === 'string' && mod.name.trim() ? mod.name.trim() : manifestValue.name,
      version: typeof mod.version === 'string' ? mod.version : manifestValue.version,
      apiVersion: contract.PLUGIN_API_VERSION,
      capabilities,
      trackKinds,
      module: mod,
    },
  };
}

/**
 * 应用一次 ticket.update 的输入，并返回"这一帧要不要真的推 IPC"。
 *
 * 状态本身（progress / message）**每次都更新**，只有推给渲染进程的动作被节流：
 * 100ms + 2% 变化阈值，与 svsIpc 的进度推送同一套参数。被节流掉的那一帧不会
 * 丢失 —— 下一次推送带上的是最新值，UI 最终看到的态是收敛的。
 *
 * @param {object} ticket
 * @param {object} next
 * @param {()=>number} now
 * @returns {boolean} 是否需要推送
 */
function applyTicketUpdate(ticket, next, now) {
  if (!ticket || ticket.ended || !next || typeof next !== 'object') return false;
  if (typeof next.message === 'string') ticket.message = next.message;
  if (Number.isFinite(next.progress)) {
    ticket.progress = Math.min(100, Math.max(0, next.progress));
  }
  const th = ticket.throttle || (ticket.throttle = { lastAt: -Infinity, lastProgress: -Infinity });
  const t = now();
  if (ticket.progress < 100
    && t - th.lastAt < TICKET_UPDATE_THROTTLE_MS
    && Math.abs(ticket.progress - th.lastProgress) < TICKET_UPDATE_PROGRESS_EPSILON) return false;
  th.lastAt = t;
  th.lastProgress = ticket.progress;
  return true;
}

/**
 * 扫一遍 Float32Array，确认里面没有 NaN / ±Infinity。
 *
 * 取舍：**全量扫描，不抽样**。一个孤立的 NaN 会顺着混音 / 导出把整段音频污染
 * 成静音或爆音，抽样必然漏掉孤立坏值；而全量扫描的成本是一次线性遍历 —— 实测
 * 每百万样本约 1ms（见 harden_plugin_host 验证脚本），相对合成本身的耗时可以
 * 忽略。循环体刻意不调用函数（不用 Number.isFinite / Math.isFinite），用
 * `v !== v`（NaN 是唯一不等于自身的值）+ 两个无穷端点判定，走纯寄存器路径；
 * 命中即 return，坏值越靠前越便宜。
 *
 * @param {Float32Array} arr
 * @param {number} [maxScan] 最多扫描多少个元素
 * @returns {number} 首个非有限值的下标，正常返回 -1
 */
function findNonFiniteIndex(arr, maxScan) {
  const limit = Math.min(arr.length, Number.isFinite(maxScan) ? maxScan : arr.length);
  for (let i = 0; i < limit; i++) {
    const v = arr[i];
    // eslint-disable-next-line no-self-compare
    if (v !== v || v === Infinity || v === -Infinity) return i;
  }
  return -1;
}

/**
 * 校验一段音频数组的形状与体量（类型 / NaN·Infinity / 字节上限 / 时长上限）。
 *
 * @param {Float32Array} arr
 * @param {object} limits {sampleRate, channels, leadingSamples}
 * @param {string} label 错误信息里用的字段路径
 */
function validatePcmArray(arr, limits, label) {
  if (!(arr instanceof Float32Array)) {
    throw new Error(`${label} 必须是 Float32Array，实际为 ${Object.prototype.toString.call(arr)}`);
  }
  const elements = arr.length;
  if (elements === 0) return;

  // 体量上限：字节数按"所有声道合计"算，控制住宿主侧与 IPC 侧的峰值内存
  const bytes = elements * arr.BYTES_PER_ELEMENT;
  if (bytes > MAX_PCM_BYTES) {
    throw new Error(
      `${label} 长度超过上限：${elements} 样本 / ${(bytes / 1024 / 1024).toFixed(1)}MiB`
      + `，单次结果不得超过 ${(MAX_PCM_BYTES / 1024 / 1024).toFixed(0)}MiB`,
    );
  }
  // 时长上限：单声道样本数 + 前置补零 <= sampleRate * MAX_PCM_DURATION_SEC
  const perChannel = elements / Math.max(1, limits.channels);
  const leading = limits.leadingSamples || 0;
  if (perChannel + leading > limits.sampleRate * MAX_PCM_DURATION_SEC) {
    throw new Error(
      `${label} 时长超过上限：约 ${((perChannel + leading) / limits.sampleRate).toFixed(1)}s`
      + `，单次合成不得超过 ${MAX_PCM_DURATION_SEC}s（长工程请按分块合成）`,
    );
  }

  const bad = findNonFiniteIndex(arr, FINITE_SCAN_WARN_ELEMENTS);
  if (bad >= 0) {
    throw new Error(`${label} 含非有限值（NaN/Infinity），首个位置 index=${bad}（值 ${arr[bad]}）`);
  }
}

/**
 * 归一化合成结果：把插件返回值收敛成混音链路能直接吃下的形状。
 * 任何一项不合法都抛错（由调用方转成 {success:false}），绝不放行脏数据。
 * @param {unknown} result
 * @param {number} fallbackSampleRate
 * @returns {{pcm: Float32Array|null, channels: number, sampleRate: number, leadingSamples: number, diagnostics: object|null}}
 */
function normalizeSynthResult(result, fallbackSampleRate) {
  if (result === null || result === undefined) {
    return { pcm: null, channels: 1, sampleRate: fallbackSampleRate, leadingSamples: 0, diagnostics: null };
  }
  if (typeof result !== 'object') {
    throw new Error('插件 synthesize() 必须返回对象或 null');
  }

  // ---- sampleRate 先算好：pcm 的长度上限要用它换算时长 ----
  if (result.sampleRate !== undefined
    && !(typeof result.sampleRate === 'number' && Number.isFinite(result.sampleRate))) {
    // 非有限值（NaN/±Infinity）不是"没给"：插件写错了就是脏数据，直接拒绝
    // 而不是静默退回 fallbackSampleRate（退回会让 UI 以为拿到了正常采样率）。
    throw new Error(`sampleRate 必须是有限数字，实际为 ${String(result.sampleRate)}`);
  }
  let sampleRate = typeof result.sampleRate === 'number' && Number.isFinite(result.sampleRate)
    ? result.sampleRate
    : fallbackSampleRate;
  if (!Number.isInteger(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new Error(`sampleRate 必须是 ${MIN_SAMPLE_RATE}..${MAX_SAMPLE_RATE} 的整数，实际为 ${String(result.sampleRate)}`);
  }

  let leadingSamples = result.leadingSamples === undefined ? 0 : result.leadingSamples;
  if (!Number.isInteger(leadingSamples) || leadingSamples < 0) {
    throw new Error(`leadingSamples 必须是 >=0 的整数，实际为 ${String(result.leadingSamples)}`);
  }

  const raw = result.pcm;
  let pcm = null;
  let channels = 1;

  if (raw === null || raw === undefined) {
    // streaming 插件允许返回 null，音频全部经 host.emitAudio 推送。
    pcm = null;
  } else if (raw instanceof Float32Array) {
    pcm = raw;
  } else if (Array.isArray(raw)) {
    if (raw.length === 0) {
      pcm = null;
    } else {
      for (const ch of raw) {
        if (!(ch instanceof Float32Array)) throw new Error('pcm 数组的元素必须都是 Float32Array');
      }
      pcm = raw;
      channels = raw.length;
    }
  } else {
    throw new Error(`pcm 必须是 Float32Array 或 Float32Array[]，实际为 ${Object.prototype.toString.call(raw)}`);
  }

  // channels：数组形态以数组长度为准，交错形态以声明为准
  if (typeof result.channels === 'number' && Number.isInteger(result.channels) && result.channels >= 1) {
    if (Array.isArray(pcm)) {
      channels = pcm.length;
    } else {
      channels = result.channels;
    }
  } else if (result.channels !== undefined) {
    throw new Error(`channels 必须是 >=1 的整数，实际为 ${JSON.stringify(result.channels)}`);
  }

  // ---- 形状与体量校验（类型 / NaN·Infinity / 字节上限 / 时长上限）----
  if (Array.isArray(pcm)) {
    for (let i = 0; i < pcm.length; i++) {
      validatePcmArray(pcm[i], { sampleRate, channels: 1, leadingSamples }, `pcm[${i}]`);
    }
  } else if (pcm) {
    validatePcmArray(pcm, { sampleRate, channels, leadingSamples }, 'pcm');
  }

  // diagnostics 只接受普通对象（渲染层会直接 JSON 化展示）
  const diagnostics = result.diagnostics && typeof result.diagnostics === 'object' && !Array.isArray(result.diagnostics)
    ? result.diagnostics
    : null;

  return { pcm, channels, sampleRate, leadingSamples, diagnostics };
}

/**
 * 清除某个目录下所有已加载模块的 require 缓存（热重载用）。
 * @param {string} dirReal 已 realpath 的插件目录
 */
function clearRequireCacheUnder(dirReal) {
  const cache = require.cache;
  if (!cache) return;
  const prefix = dirReal + path.sep;
  for (const key of Object.keys(cache)) {
    if (key === dirReal || key.startsWith(prefix)) {
      delete cache[key];
      continue;
    }
    // require.cache 的键可能是符号链接路径，比较 realpath 兜底
    const real = safeRealpath(key);
    if (real && (real === dirReal || real.startsWith(prefix))) delete cache[key];
  }
}

/**
 * 创建插件宿主实例。
 *
 * @param {object} [options]
 * @param {string} [options.pluginsDir]            插件根目录（默认 <userData>/plugins）
 * @param {object} [options.security]              安全层（默认 ./security）
 * @param {number} [options.callTimeoutMs]         单次调用超时（默认 PLUGIN_CALL_TIMEOUT_MS）
 * @param {number} [options.ticketWatchdogMs]      ticket 兜底寿命（默认 10 分钟）
 * @param {string} [options.hostVersion]           传给 ctx.hostVersion 的版本
 * @param {(key:string)=>unknown} [options.getSetting]
 * @param {(level:string, scope:string, message:string)=>void} [options.log]
 * @param {()=>number} [options.now]               时钟注入（测试用）
 * @param {string} [options.executionMode]         默认执行模式（缺省 'worker'）
 * @param {Iterable<string>} [options.inprocessWhitelist] 允许跑 in-process 的插件 id
 */
function createPluginHost(options) {
  const opts = options || {};
  const security = opts.security || require('./security');
  const pluginsDir = path.resolve(opts.pluginsDir || defaultPluginsDir());
  const callTimeoutMs = Number.isFinite(opts.callTimeoutMs) ? opts.callTimeoutMs : contract.PLUGIN_CALL_TIMEOUT_MS;
  const ticketWatchdogMs = Number.isFinite(opts.ticketWatchdogMs) ? opts.ticketWatchdogMs : TICKET_WATCHDOG_MS;
  const hostVersion = opts.hostVersion || defaultHostVersion();
  const getSetting = typeof opts.getSetting === 'function' ? opts.getSetting : defaultGetSetting;
  const logSink = typeof opts.log === 'function' ? opts.log : defaultLogSink;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  // 进程内模式只接受白名单内的插件：这里是最终的"必须有人显式担责"的位置。
  const inprocessWhitelist = new Set(
    Array.isArray(opts.inprocessWhitelist) ? opts.inprocessWhitelist
      : (opts.inprocessWhitelist && typeof opts.inprocessWhitelist[Symbol.iterator] === 'function'
        ? [...opts.inprocessWhitelist] : []),
  );

  /** @type {Map<string, object>} pluginId -> 插件记录 */
  const plugins = new Map();
  /** 最近一次扫描/加载的失败清单（UI 直接展示） */
  let lastErrors = [];
  /** @type {Map<string, object>} ticketId -> ticket */
  const tickets = new Map();
  let ticketSeq = 0;
  let hostDisposed = false;

  function log(level, scope, message) {
    try {
      logSink(LOG_LEVELS.includes(level) ? level : 'info', scope, message);
    } catch (_) { /* 日志出口不能反噬宿主 */ }
  }

  /** 插件侧 ctx.log */
  function makePluginLogger(scope) {
    return (level, message) => {
      const text = typeof message === 'string' ? message : describeError(message);
      log(level, scope, text);
    };
  }

  /**
   * 向渲染进程推事件。sender 通常是 event.sender（webContents）或 BrowserWindow。
   * 任何发送失败都被吞掉：UI 不在了不该让合成失败。
   * @param {object} sender
   * @param {string} channel
   * @param {object} payload
   */
  function sendTo(sender, channel, payload) {
    if (!sender || typeof sender.send !== 'function') return false;
    try {
      if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return false;
      sender.send(channel, payload);
      return true;
    } catch (err) {
      log('warn', null, `推送 ${channel} 失败：${describeError(err)}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // 阻滞播放（blockPlayback）ticket
  // ---------------------------------------------------------------------

  function ticketPayload(ticket) {
    return {
      ticketId: ticket.id,
      pluginId: ticket.pluginId,
      title: ticket.title,
      message: ticket.message,
      progress: ticket.progress,
      cancellable: ticket.cancellable === true,
    };
  }

  /** 结束并回收 ticket（幂等），同时通知 UI 收起阻滞面板。 */
  function endTicket(ticket, reason) {
    if (!ticket || ticket.ended) return false;
    ticket.ended = true;
    if (ticket.watchdog) {
      clearTimeout(ticket.watchdog);
      ticket.watchdog = null;
    }
    tickets.delete(ticket.id);
    sendTo(ticket.sender, 'plugin:blocking-end', {
      ...ticketPayload(ticket),
      reason: reason || 'done',
      cancelled: ticket.cancelled === true,
    });
    return true;
  }

  /**
   * 创建阻滞 ticket。只有声明 capabilities.blockPlayback 的插件能创建成功。
   * @param {object} record
   * @param {object} call 本次调用上下文
   * @param {object} payload {title, message, cancellable}
   * @param {string} [forcedId] worker 模式用的**预先分配** id：插件侧必须同步拿到
   *        ticket.id（`ticket.id` 不能跨线程异步往返），所以 id 在调用开始时
   *        就一次性分配下发，真正的 ticket 在这里按同一个 id 建起来。
   * @returns {object|null} ticket 句柄，被拒绝时返回 null
   */
  function createTicket(record, call, payload, forcedId) {
    if (!record.capabilities.blockPlayback) {
      log('warn', record.id, '调用 blockPlayback 但未声明 capabilities.blockPlayback，已拒绝');
      return null;
    }
    if (call.tickets.size >= MAX_TICKETS_PER_CALL) {
      log('warn', record.id, `单次调用的阻滞 ticket 数量超过上限 ${MAX_TICKETS_PER_CALL}，已拒绝`);
      return null;
    }

    const input = payload && typeof payload === 'object' ? payload : {};
    const ticket = {
      id: forcedId || `pt-${++ticketSeq}`,
      pluginId: record.id,
      title: typeof input.title === 'string' ? input.title : '插件处理中',
      message: typeof input.message === 'string' ? input.message : '',
      progress: Number.isFinite(input.progress) ? Math.min(100, Math.max(0, input.progress)) : 0,
      cancellable: input.cancellable === true,
      cancellableRequested: false,
      ended: false,
      sender: call.sender,
      // 反查本次调用：取消时要能同时置位 call.cancelled 并 abort request.abortSignal
      callRef: call,
      watchdog: null,
      // ticket.update 的节流状态：句柄路径（in-process / 回调）与 worker 的消息
      // 路径共用同一份，两个来源混用时窗口不会被重复刷新
      throttle: { lastAt: -Infinity, lastProgress: -Infinity },
    };
    tickets.set(ticket.id, ticket);
    call.tickets.add(ticket.id);

    // 兜底：插件忘记 end() 时（含插件挂死、宿主超时中断），最多挂 ticketWatchdogMs。
    ticket.watchdog = setTimeout(() => {
      log('warn', record.id, `阻滞 ticket ${ticket.id} 超过 ${ticketWatchdogMs}ms 未 end()，宿主强制结束`);
      endTicket(ticket, 'watchdog');
    }, ticketWatchdogMs);
    if (typeof ticket.watchdog.unref === 'function') ticket.watchdog.unref();

    sendTo(ticket.sender, 'plugin:blocking-start', ticketPayload(ticket));

    return {
      id: ticket.id,
      /**
       * 更新阻滞面板。
       *
       * 节流规则与 svsIpc 的进度推送一致（100ms + 2% 变化阈值）：只推"距上次推送
       * 超过 100ms"或"进度变化超过 2%"或"已到终态 100%"三类更新。实测 400 音符
       * 逐音符 update 原本会产生 400+ 次 `plugin:blocking-update`，节流后降到
       * 个位数（这些 IPC 本来 UI 也来不及渲染）。
       */
      update(next) {
        if (!applyTicketUpdate(ticket, next, now)) return false;
        sendTo(ticket.sender, 'plugin:blocking-update', ticketPayload(ticket));
        return true;
      },
      end() {
        return endTicket(ticket, 'done');
      },
      isCancelled() {
        return ticket.cancelled === true;
      },
    };
  }

  /** 调用结束（成功/失败/超时）后回收本次调用创建的所有 ticket。 */
  function endCallTickets(call) {
    if (!call || !call.tickets.size) return;
    for (const id of [...call.tickets]) {
      const ticket = tickets.get(id);
      if (ticket) endTicket(ticket, ticket.cancelled ? 'cancelled' : 'call-finished');
    }
    call.tickets.clear();
  }

  // ---------------------------------------------------------------------
  // host 回调集合（插件的输出通道）
  // ---------------------------------------------------------------------

  /**
   * @param {object} record
   * @param {object} call { sender, tickets:Set<string>, controller:AbortController, cancelled:boolean }
   */
  function makeHostApi(record, call) {
    let lastProgressAt = -Infinity;
    let progressStarted = false;

    return {
      /** 进度 0..100，节流后推给请求方窗口。 */
      emitProgress(progress) {
        if (!Number.isFinite(progress)) return false;
        const value = Math.min(100, Math.max(0, progress));
        const t = now();
        // 首次与终态必发，其余按 PROGRESS_THROTTLE_MS 节流，避免 IPC 打满。
        if (progressStarted && value < 100 && t - lastProgressAt < PROGRESS_THROTTLE_MS) return false;
        progressStarted = true;
        lastProgressAt = t;
        return sendTo(call.sender, 'plugin:progress', { pluginId: record.id, progress: value });
      },
      /** 流式音频分片：{pcm, channels, sampleRate, startTimeSec}。 */
      emitAudio(chunk) {
        if (!chunk || typeof chunk !== 'object') return false;
        if (!(chunk.pcm instanceof Float32Array)) {
          log('warn', record.id, 'emitAudio 的 chunk.pcm 不是 Float32Array，已丢弃');
          return false;
        }
        // 分片也要过同一套"有限值 + 体量"校验：这里是脏数据进混音链路的
        // 另一条通道，漏了它等于给前面的返回校验开了后门。
        const channels = Number.isInteger(chunk.channels) && chunk.channels >= 1 ? chunk.channels : 1;
        try {
          validatePcmArray(chunk.pcm, {
            sampleRate: Number.isFinite(chunk.sampleRate) && chunk.sampleRate > 0
              ? chunk.sampleRate : DEFAULT_SAMPLE_RATE,
            channels,
            leadingSamples: 0,
          }, 'emitAudio chunk.pcm');
        } catch (err) {
          log('warn', record.id, `emitAudio 分片被拒绝：${describeError(err)}`);
          return false;
        }
        return sendTo(call.sender, 'plugin:audio', {
          pluginId: record.id,
          pcm: chunk.pcm,
          channels,
          sampleRate: Number.isFinite(chunk.sampleRate) ? chunk.sampleRate : 0,
          startTimeSec: Number.isFinite(chunk.startTimeSec) ? chunk.startTimeSec : 0,
          isLast: chunk.isLast === true,
        });
      },
      log(level, message) {
        makePluginLogger(record.id)(level, message);
        return true;
      },
      /**
       * 阻滞播放：UI 显示 {title, message, progress} 直到 ticket.end()。
       * 未声明 capabilities.blockPlayback 的插件返回 null。
       */
      blockPlayback(payload) {
        return createTicket(record, call, payload);
      },
      /** 插件可感知的取消标志（ticket 取消 或 abortSignal 已 abort）。 */
      isCancelled() {
        return call.cancelled === true || (call.controller && call.controller.signal.aborted === true);
      },
      /** 任意诊断对象，原样转交 UI。 */
      diagnostics(obj) {
        if (!obj || typeof obj !== 'object') return false;
        return sendTo(call.sender, 'plugin:diagnostics', { pluginId: record.id, diagnostics: obj });
      },
    };
  }

  // ---------------------------------------------------------------------
  // worker 模式：真正可抢占的执行环境（executionMode='worker'，默认）
  // ---------------------------------------------------------------------

  /** worker 调用 id 序列（跨插件复用即可，id 只在"本次调用"内需要唯一） */
  let workerCallSeq = 0;

  /**
   * 决定某个插件跑在哪个模式。
   *
   * - 默认 `'worker'`；
   * - 只有在 manifest 显式声明 `executionMode:'inprocess'` **且**插件 id 在 host
   *   白名单里时才真正走进程内，并打出告警：这个模式下插件的同步阻塞无法被抢占
   *   （见文件头注释），必须由有人认领这个风险。
   * - 声明了但不在白名单 → 降级为 worker（继续可用），并打告警。
   *
   * @param {object} manifestValue 已校验的 manifest
   */
  function decideExecutionMode(manifestValue) {
    const id = manifestValue.id;
    if (manifestValue.executionMode !== 'inprocess') return 'worker';
    if (inprocessWhitelist.has(id)) {
      log('warn', id, '该插件以 executionMode=inprocess 加载：同步忙等/死循环将冻结主进程且无法被超时打断');
      return 'inprocess';
    }
    log('warn', id, 'manifest 声明 executionMode=inprocess 但不在宿主白名单内，已按 worker 模式加载');
    return 'worker';
  }

  /**
   * 由 worker 回传的元数据拼出一份"看起来像插件模块"的对象，好让
   * validateModule() 这套契约校验在两个模式下**完全复用**（worker 模式下主进程
   * 永远不 require 插件代码）。
   * @param {object} meta
   */
  function metaToSyntheticModule(meta) {
    const has = (meta && meta.has) || {};
    const proxy = function _pluginMethodProxy() { return Promise.resolve(null); };
    return {
      id: meta ? meta.id : undefined,
      name: meta ? meta.name : undefined,
      version: meta ? meta.version : undefined,
      apiVersion: meta ? meta.apiVersion : undefined,
      capabilities: meta ? meta.capabilities : undefined,
      trackKinds: meta ? meta.trackKinds : undefined,
      initialize: has.initialize ? proxy : undefined,
      getVoices: has.getVoices ? proxy : undefined,
      synthesize: has.synthesize ? proxy : undefined,
      dispose: has.dispose ? proxy : undefined,
    };
  }

  /** 把某次调用（或 initialize）里所有 pending 状态的调用全部用一个错误收掉。 */
  function failPendingCalls(record, error) {
    if (!record || !record.pending) return;
    const list = [...record.pending.values()];
    record.pending.clear();
    for (const pending of list) pending.reject(error);
  }

  /**
   * 终止 worker 线程。超时就用它做真正的抢占 —— worker 里的同步死循环也能被
   * terminate 掐断（Node 会给那个线程下发 V8 终止请求）。
   * @param {object} record
   */
  async function terminateWorker(record) {
    const worker = record.worker;
    record.worker = null;
    // worker 被杀 = 插件实例没了状态，下次调用前必须重新 initialize
    record.needsInit = true;
    if (!worker) return;
    try {
      await worker.terminate();
    } catch (err) {
      log('warn', record.id, `终止插件 worker 失败（忽略）：${describeError(err)}`);
    }
  }

  /**
   * 处理 worker 发回来的**回调代理调用**：在主进程执行真函数，并把结果搬回去。
   * 走这条路的是 options.onProgress / refF0Extractor / ctx.log / ctx.getSetting
   * 这类"主进程才有真身"的函数。
   */
  async function handleRemoteCallback(record, msg) {
    const found = (record.persistentCallbacks && record.persistentCallbacks.get(msg.cbId))
      || findPendingCallback(record, msg.cbId);
    if (!found || typeof found.fn !== 'function') {
      // 查不到就返回 undefined 而不是报错：插件经常 fire-and-forget 地调用回调
      // （例如 ctx.log），拒了只会制造一堆 unhandled rejection。
      replyCallbackResult(record, msg.reqId, { ok: true, value: undefined });
      return;
    }
    try {
      const value = await found.fn(...(msg.args || []));
      const ctx = wire.newEncodeContext();
      const encoded = wire.encodeWire(value, ctx, 'callbackResult', 0);
      replyCallbackResult(record, msg.reqId, { ok: true, value: encoded }, ctx);
    } catch (err) {
      replyCallbackResult(record, msg.reqId, { ok: false, error: describeError(err) });
    }
  }

  /**
   * @param {object} record
   * @param {number} reqId
   * @param {object} payload
   * @param {object} [ctx] encode 上下文（有 transfer 列表时带上）
   */
  function replyCallbackResult(record, reqId, payload, ctx) {
    const worker = record.worker;
    if (!worker) return;
    const transfer = ctx ? [...ctx.transfer] : [];
    const msg = { type: 'callback-result', reqId, ...payload };
    try {
      if (transfer.length) worker.postMessage(msg, transfer);
      else worker.postMessage(msg);
    } catch (_) {
      try { worker.postMessage({ type: 'callback-result', reqId, ok: true, value: undefined }); } catch (__) {}
    }
  }

  /**
   * 在正在进行的调用里找回调真身。
   * @param {object} record
   * @param {number} cbId
   */
  function findPendingCallback(record, cbId) {
    if (!record.pending) return null;
    for (const pending of record.pending.values()) {
      const found = pending.callbacks && pending.callbacks.get(cbId);
      if (found) return found;
    }
    return null;
  }

  /**
   * worker 侧插件调用 host.* 时发来的事件。真节流、真 ticket、真 IPC 推送都留在
   * 主进程 —— 插件侧看到的只是同名代理。
   * @param {object} record
   * @param {object} msg
   */
  function handleHostEvent(record, msg) {
    const pending = record.pending && record.pending.get(msg.callId);
    const call = pending && pending.call;
    if (!call) {
      // 调用已经结算（成功/失败/超时）之后才到达的 host 回调：插件多半是在后台
      // 异步任务里发的，这里丢掉最安全 —— ticket / IPC 通道都已经被回收。
      log('debug', record.id, `忽略已结束调用(${msg.callId})的 host.${msg.kind} 回调`);
      return;
    }
    const host = call.host || (call.host = makeHostApi(record, call));
    switch (msg.kind) {
      case 'progress':
        host.emitProgress(msg.value);
        break;
      case 'audio': {
        const chunk = msg.value && typeof msg.value === 'object' ? msg.value : {};
        host.emitAudio({
          pcm: chunk.pcm,
          channels: chunk.channels,
          sampleRate: chunk.sampleRate,
          startTimeSec: chunk.startTimeSec,
          isLast: chunk.isLast,
        });
        break;
      }
      case 'log':
        host.log(msg.level, msg.message);
        break;
      case 'diagnostics':
        host.diagnostics(msg.value);
        break;
      case 'ticket-start': {
        // id 是本次调用开始时预先分配好的（插件必须同步拿到 ticket.id）
        createTicket(record, call, msg.value, msg.ticketId);
        break;
      }
      case 'ticket-update': {
        const ticket = tickets.get(msg.ticketId);
        if (ticket && applyTicketUpdate(ticket, msg.value, now)) {
          sendTo(ticket.sender, 'plugin:blocking-update', ticketPayload(ticket));
        }
        break;
      }
      case 'ticket-end': {
        const ticket = tickets.get(msg.ticketId);
        if (ticket) endTicket(ticket, 'done');
        if (call.tickets) call.tickets.delete(msg.ticketId);
        break;
      }
      default:
        break;
    }
  }

  /**
   * worker 消息总入口（'meta' 由启动流程的专属监听器消费，这里不处理）。
   */
  function handleWorkerMessage(record, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'callback':
        // 主进程回调可能在插件里被 await，不能在 try 里同步吞异常以外的东西
        void handleRemoteCallback(record, msg);
        break;
      case 'host':
        handleHostEvent(record, msg);
        break;
      case 'result': {
        const pending = record.pending && record.pending.get(msg.callId);
        if (!pending) return;
        record.pending.delete(msg.callId);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(new Error(msg.error || '插件调用失败'));
        break;
      }
      case 'failed': {
        log('error', record.id, `插件 worker 出现未捕获异常：${msg.error}`);
        failPendingCalls(record, new Error(`插件 worker 未捕获异常：${msg.error}`));
        void terminateWorker(record);
        break;
      }
      default:
        break;
    }
  }

  /**
   * 拉起插件 worker，并等待它 require 完入口、把元数据发回来。
   *
   * worker 是在**另一个线程**里 require 插件的：入口顶层代码的同步阻塞、导出
   * 校验、后续所有调用都在那边，主进程只负责收发消息，所以这条线上的任何卡死
   * 都能被 `worker.terminate()` 打断。
   *
   * @param {object} record
   * @returns {Promise<object>} 插件元数据（name/version/capabilities/trackKinds/has）
   */
  async function spawnWorker(record) {
    // eslint-disable-next-line global-require
    const { Worker } = require('node:worker_threads');
    const entry = resolveWorkerEntry();
    if (!entry) {
      throw new Error(`找不到插件 worker 入口（已尝试：${WORKER_ENTRY_CANDIDATES.join('、')}）`);
    }
    // A1：worker_threads 不是安全边界（插件仍与宿主同进程、可 require 任意模块），
    // 但至少要把它的资源封顶：一个跑飞的插件不该把整个应用拖进 OOM。
    const worker = new Worker(entry, {
      resourceLimits: PLUGIN_WORKER_RESOURCE_LIMITS,
    });
    record.worker = worker;
    // 新线程的插件实例是全新的：调用前必须先重新 initialize
    record.needsInit = true;
    if (!record.pending) record.pending = new Map();

    worker.on('message', (msg) => handleWorkerMessage(record, msg));
    worker.on('error', (err) => {
      log('error', record.id, `插件 worker 异常：${describeError(err)}`);
      failPendingCalls(record, new Error(`插件 worker 异常：${describeError(err)}`));
      void terminateWorker(record);
    });
    worker.on('exit', (code) => {
      if (record.worker === worker) record.worker = null;
      record.needsInit = true;
      failPendingCalls(record, new Error(`插件 worker 已退出（code=${code}）`));
    });

    let settled = false;
    const metaPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.off('message', onMeta);
        void terminateWorker(record);
        reject(new Error(`插件 worker 启动超时：超过 ${callTimeoutMs}ms 未完成初始化（入口顶层代码可能卡住了）`));
      }, Math.max(1, callTimeoutMs));
      function onMeta(msg) {
        if (!msg || msg.type !== 'meta') return;
        settled = true;
        clearTimeout(timer);
        worker.off('message', onMeta);
        resolve(msg);
      }
      worker.on('message', onMeta);
    });

    // 权限白名单随 init 一起下发：插件线程据此拦截高危模块的 require（A1）。
    worker.postMessage({
      type: 'init',
      entry: record.entry,
      permissions: Array.isArray(record.permissions) ? record.permissions : null,
    });
    const meta = await metaPromise;
    if (!meta.ok) {
      await terminateWorker(record);
      throw new Error(meta.error || '插件 worker 初始化失败');
    }
    record.meta = meta.meta;
    return meta.meta;
  }

  /**
   * 保证 worker 存活：被超时抢占过的插件会在下一次调用时在这里重新拉起（重新
   * require 入口 + 重新 initialize，见 callInWorker）。
   * @param {object} record
   * @returns {Promise<object>} Worker 实例
   */
  async function ensureWorker(record) {
    if (record.worker) return record.worker;
    await spawnWorker(record);
    return record.worker;
  }

  /**
   * worker 模式下交给插件 initialize() 的 ctx。log / getSetting 在主进程保留
   * 真身，插件侧拿到的是跨线程代理（见 pluginWorker.js）。
   * @param {object} record
   */
  function makeWorkerInitCtx(record) {
    return {
      pluginId: record.id,
      pluginDir: record.dir,
      hostVersion,
      log: makePluginLogger(record.id),
      getSetting,
    };
  }

  /**
   * 在 worker 里执行一次插件方法。
   *
   * @param {object} record
   * @param {string} method initialize / getVoices / synthesize / dispose
   * @param {Array} rawArgs 可以是任意 JS 值（函数会被换成代理，TypedArray 会被转移）
   * @param {object} options
   * @param {number} options.timeoutMs
   * @param {object} [options.call] 本次调用上下文（host 事件需要它）
   * @param {string[]} [options.ticketPool] 预先分配的 ticket id
   * @returns {Promise<unknown>} 插件的返回值（已经过一次跨线程还原）
   */
  async function callInWorker(record, method, rawArgs, options) {
    const opts = options || {};
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : callTimeoutMs;
    await ensureWorker(record);
    if (record.needsInit && method !== 'initialize' && record.has && record.has.initialize) {
      // worker 被重新拉起（超时抢占 / 崩溃）后，插件实例是全新的，必须先重新
      // initialize，否则插件会用自己认为"还没初始化"的状态报错。
      await callInWorker(record, 'initialize', [makeWorkerInitCtx(record)], { timeoutMs: callTimeoutMs });
    }

    const callId = `${record.id}#${++workerCallSeq}`;
    const ctx = wire.newEncodeContext((hint) => {
      log('warn', record.id, `跨线程传输时丢弃了不可克隆值：${hint}`);
    });
    let encodedArgs;
    try {
      encodedArgs = rawArgs.map((item, i) => wire.encodeWire(item, ctx, `args[${i}]`, 0));
    } catch (err) {
      throw new Error(`插件调用参数序列化失败：${describeError(err)}`);
    }

    // 回调真身：initialize 的 ctx.log / ctx.getSetting 要活到 dispose，其余跟本次调用
    const callbacks = new Map();
    for (const [cbId, entry] of ctx.callbacks) callbacks.set(cbId, entry);
    if (method === 'initialize') {
      for (const [cbId, entry] of callbacks) record.persistentCallbacks.set(cbId, entry);
    }

    let timer = null;
    if (opts.call) {
      // 取消时要能反查"这条调用对应的 worker / callId"（见 requestTicketCancel）
      opts.call.callId = callId;
      opts.call.recordRef = record;
    }
    const promise = new Promise((resolve, reject) => {
      record.pending.set(callId, { resolve, reject, callbacks, call: opts.call || null });
      timer = setTimeout(() => {
        record.pending.delete(callId);
        record.consecutiveTimeouts = (record.consecutiveTimeouts || 0) + 1;
        const exhausted = record.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS;
        // ★ 真正的抢占：中止另一个线程里的那段正在执行的插件代码
        void terminateWorker(record);
        if (exhausted) {
          record.state = 'failed';
          record.error = `连续 ${MAX_CONSECUTIVE_TIMEOUTS} 次调用超时，插件已标记为不可用（需 reload 恢复）`;
          log('error', record.id, record.error);
        }
        reject(new Error(
          `插件调用超时：${record.id}.${method} 超过 ${timeoutMs}ms 未返回（worker 已终止${
            exhausted ? '，插件已标记为不可用，需 reload 恢复' : '，下次调用会重新拉起'
          }）`,
        ));
      }, Math.max(1, timeoutMs));
    });

    try {
      record.worker.postMessage(
        { type: 'call', callId, method, args: encodedArgs, ticketPool: opts.ticketPool || [] },
        [...ctx.transfer],
      );
    } catch (err) {
      clearTimeout(timer);
      record.pending.delete(callId);
      log('warn', record.id, `向插件 worker 投递调用失败：${describeError(err)}`);
      throw err;
    }

    try {
      const value = await promise;
      // 一次成功就把"连续超时"计数清零：超时可能只是用户把超时调得太小
      record.consecutiveTimeouts = 0;
      return value;
    } finally {
      clearTimeout(timer);
      record.pending.delete(callId);
    }
  }

  // ---------------------------------------------------------------------
  // 加载 / 生命周期
  // ---------------------------------------------------------------------

  /**
   * 解析入口文件绝对路径，并确认它落在插件目录内。
   * @param {string} pluginDirReal
   * @param {string} mainRel
   */
  function resolveEntry(pluginDirReal, mainRel) {
    const candidate = path.resolve(pluginDirReal, mainRel);
    const rel = path.relative(pluginDirReal, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`入口路径越出插件目录：${mainRel}`);
    }
    const real = safeRealpath(candidate);
    if (!real) throw new Error(`入口文件不存在：${mainRel}`);
    // 符号链接逃逸：realpath 后必须仍在插件目录内
    if (!isInside(pluginDirReal, real)) {
      throw new Error(`入口路径经符号链接逃逸出插件目录：${mainRel}`);
    }
    if (!fs.statSync(real).isFile()) throw new Error(`入口不是文件：${mainRel}`);
    return real;
  }

  /**
   * worker 模式加载：在主进程**不 require** 插件代码，一切都交给 worker 线程，
   * 主进程只拿到 worker 回传的元数据做契约校验。
   *
   * @param {string} realDir
   * @param {object} manifestValue 已校验的 manifest
   * @param {string} entry
   * @returns {Promise<object|null>}
   */
  async function loadPluginDirWorker(realDir, manifestValue, entry) {
    const mode = decideExecutionMode(manifestValue);
    const record = {
      id: manifestValue.id,
      dir: realDir,
      entry,
      manifest: manifestValue,
      mode,
      state: 'loaded',
      error: null,
      // worker 模式的运行时字段
      worker: null,
      pending: new Map(),
      persistentCallbacks: new Map(),
      has: null,
      needsInit: true,
      consecutiveTimeouts: 0,
      // A1: manifest 里声明的权限白名单（空数组 = 未声明，不做 require 拦截）
      permissions: Array.isArray(manifestValue.permissions) ? manifestValue.permissions : [],
    };

    let meta;
    try {
      meta = await spawnWorker(record);
    } catch (err) {
      // entry 顶层代码卡死 / require 失败 / 元数据搬运失败 —— 全部只影响这一个插件
      const message = describeError(err);
      log('error', record.id, `加载失败：${message}`);
      lastErrors.push({ pluginId: record.id, stage: 'load', message });
      return null;
    }

    const checkedModule = validateModule(metaToSyntheticModule(meta), manifestValue);
    if (!checkedModule.ok) {
      await terminateWorker(record);
      log('error', record.id, `加载失败：${checkedModule.error}`);
      lastErrors.push({ pluginId: record.id, stage: 'load', message: checkedModule.error });
      return null;
    }

    record.name = checkedModule.value.name;
    record.version = checkedModule.value.version;
    record.description = manifestValue.description;
    record.author = manifestValue.author;
    record.capabilities = checkedModule.value.capabilities;
    record.trackKinds = checkedModule.value.trackKinds;
    record.has = meta && meta.has ? { ...meta.has } : null;

    plugins.set(record.id, record);
    log('info', record.id, `已加载 ${record.name} v${record.version}（${record.trackKinds.length} 个轨道种类，worker 模式）`);
    return record;
  }

  /**
   * 加载单个插件目录（不 initialize）。任何失败都被记录并跳过。
   * @param {string} dirName
   * @returns {Promise<object|null>}
   */
  async function loadPluginDir(dirName) {
    const pluginRootReal = safeRealpath(pluginsDir) || pluginsDir;
    const dir = path.join(pluginRootReal, dirName);
    try {
      const realDir = safeRealpath(dir);
      if (!realDir || !fs.statSync(realDir).isDirectory()) {
        throw new Error('插件目录不可读');
      }
      if (!isInside(pluginRootReal, realDir)) {
        throw new Error('插件目录经符号链接逃逸出 plugins 根目录');
      }
      // 主进程内部显式授权：不依赖渲染进程授权（file:authorizePath 已收紧）。
      security.authorizePath(realDir);

      const manifest = readManifest(path.join(realDir, 'manifest.json'));
      const checkedManifest = validateManifest(manifest, dirName);
      if (!checkedManifest.ok) throw new Error(checkedManifest.error);

      const entry = resolveEntry(realDir, checkedManifest.value.main);
      security.authorizePath(entry);

      const mode = decideExecutionMode(checkedManifest.value);
      if (mode === 'worker') {
        return await loadPluginDirWorker(realDir, checkedManifest.value, entry);
      }

      // ---- in-process：插件代码直载进主进程（见文件头的"无法抢占"说明）----
      // eslint-disable-next-line global-require
      const mod = require(entry);
      const checkedModule = validateModule(mod, checkedManifest.value);
      if (!checkedModule.ok) {
        clearRequireCacheUnder(realDir);
        throw new Error(checkedModule.error);
      }

      const record = {
        id: checkedManifest.value.id,
        dir: realDir,
        entry,
        manifest: checkedManifest.value,
        name: checkedModule.value.name,
        version: checkedModule.value.version,
        description: checkedManifest.value.description,
        author: checkedManifest.value.author,
        capabilities: checkedModule.value.capabilities,
        trackKinds: checkedModule.value.trackKinds,
        module: checkedModule.value.module,
        mode: 'inprocess',
        state: 'loaded', // loaded → ready / failed / disposed
        error: null,
        pending: new Map(),
        persistentCallbacks: new Map(),
        has: null,
        needsInit: true,
        consecutiveTimeouts: 0,
      };
      plugins.set(record.id, record);
      log('info', record.id, `已加载 ${record.name} v${record.version}（${record.trackKinds.length} 个轨道种类，in-process 模式）`);
      return record;
    } catch (err) {
      const message = describeError(err);
      log('error', dirName, `加载失败：${message}`);
      lastErrors.push({ pluginId: dirName, stage: 'load', message });
      return null;
    }
  }

  /**
   * initialize 单个插件。失败只影响该插件。
   * @param {object} record
   */
  async function initializePlugin(record) {
    const hasInitialize = record.mode === 'worker'
      ? !!(record.has && record.has.initialize)
      : typeof (record.module && record.module.initialize) === 'function';
    if (!hasInitialize) {
      record.state = 'ready';
      return true;
    }
    try {
      const ctx = {
        pluginId: record.id,
        pluginDir: record.dir,
        hostVersion,
        log: makePluginLogger(record.id),
        getSetting,
      };
      if (record.mode === 'worker') {
        await callInWorker(record, 'initialize', [ctx], { timeoutMs: callTimeoutMs });
      } else {
        // ⚠️ in-process：这里的"超时"只能拦住插件的异步等待，拦不住同步忙等
        await withTimeout(
          record.module.initialize.call(record.module, ctx),
          callTimeoutMs,
          `${record.id}.initialize`,
        );
      }
      record.state = 'ready';
      record.needsInit = false;
      log('info', record.id, 'initialize 完成');
      return true;
    } catch (err) {
      record.state = 'failed';
      record.error = describeError(err);
      lastErrors.push({ pluginId: record.id, stage: 'initialize', message: record.error });
      log('error', record.id, `initialize 失败：${record.error}`);
      return false;
    }
  }

  /** dispose 单个插件（超时与异常都隔离）。 */
  async function disposePlugin(record) {
    if (!record || record.state === 'disposed') return;
    record.state = 'disposed';
    const hasDispose = record.mode === 'worker'
      ? !!(record.has && record.has.dispose)
      : typeof (record.module && record.module.dispose) === 'function';
    if (!hasDispose) {
      if (record.mode === 'worker') await terminateWorker(record);
      return;
    }
    try {
      if (record.mode === 'worker') {
        await callInWorker(record, 'dispose', [], { timeoutMs: callTimeoutMs });
      } else {
        await withTimeout(record.module.dispose.call(record.module), callTimeoutMs, `${record.id}.dispose`);
      }
    } catch (err) {
      log('warn', record.id, `dispose 失败（忽略）：${describeError(err)}`);
    } finally {
      // worker 模式的插件实例随线程一起消失，不需要清 require 缓存
      if (record.mode === 'worker') await terminateWorker(record);
    }
  }

  /** 扫描插件根目录下的子目录名。 */
  function scanDirNames() {
    // 根目录本身也要授权：插件读取模型文件时会走 isPathAllowed 校验。
    security.authorizePath(pluginsDir);
    let entries;
    try {
      entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    } catch (err) {
      const message = describeError(err);
      // 目录不存在是首次启动的正常状态，不记为插件错误。
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        log('info', null, `插件目录不存在，跳过扫描：${pluginsDir}`);
        return [];
      }
      lastErrors.push({ pluginId: null, stage: 'scan', message });
      log('error', null, `扫描插件目录失败：${message}`);
      return [];
    }
    return entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
      .map((e) => e.name);
  }

  /**
   * 扫描并加载全部插件（含 initialize）。
   * @returns {Promise<{success:boolean, plugins:object[], errors:object[], pluginsDir:string}>}
   */
  async function loadPlugins() {
    lastErrors = [];
    const dirNames = scanDirNames();
    const loaded = [];
    for (const dirName of dirNames) {
      // 单个插件失败不影响其它插件：loadPluginDir 内部已兜住所有异常。
      // worker 模式要等 worker 握手拿元数据，所以这里是串行的 await。
      const record = await loadPluginDir(dirName);
      if (record) loaded.push(record);
    }
    for (const record of loaded) {
      await initializePlugin(record);
    }
    return {
      success: true,
      pluginsDir,
      plugins: listPlugins(),
      errors: [...lastErrors],
    };
  }

  /** 序列化插件清单（不含模块对象等内部引用，可直接过 IPC）。 */
  function listPlugins() {
    const out = [];
    for (const record of plugins.values()) {
      out.push({
        id: record.id,
        name: record.name,
        version: record.version,
        apiVersion: record.manifest.apiVersion,
        description: record.description,
        author: record.author,
        capabilities: { ...record.capabilities },
        trackKinds: record.trackKinds.map((k) => ({ ...k, editor: { ...k.editor } })),
        state: record.state,
        error: record.error,
        dir: record.dir,
        executionMode: record.mode || 'inprocess',
      });
    }
    return out;
  }

  /**
   * 热重载：dispose 旧实例 → 清 require 缓存 → 重新扫描加载。
   * @returns {Promise<{success:boolean, plugins:object[], errors:object[], pluginsDir:string}>}
   */
  async function reloadPlugins() {
    const old = [...plugins.values()];
    plugins.clear();
    for (const record of old) {
      await disposePlugin(record);
      // worker 模式的 require 发生在线程里，只需要清 in-process 加载过的那条路线
      if (record.mode !== 'worker') clearRequireCacheUnder(record.dir);
    }
    // 兜底：残留 ticket 全部收掉，避免 UI 永久卡在阻滞态
    for (const ticket of [...tickets.values()]) endTicket(ticket, 'reload');
    tickets.clear();
    log('info', null, `已卸载 ${old.length} 个插件，开始重新扫描`);
    return loadPlugins();
  }

  /** 宿主关闭：dispose 所有插件并回收 ticket。 */
  async function dispose() {
    if (hostDisposed) return { success: true };
    hostDisposed = true;
    const old = [...plugins.values()];
    plugins.clear();
    for (const record of old) await disposePlugin(record);
    for (const ticket of [...tickets.values()]) endTicket(ticket, 'host-disposed');
    tickets.clear();
    return { success: true };
  }

  // ---------------------------------------------------------------------
  // 调用入口
  // ---------------------------------------------------------------------

  /**
   * 取得可调用插件，返回 {ok:true, record} 或 {ok:false, error}。
   * @param {string} pluginId
   * @param {string} method
   */
  function resolveCallable(pluginId, method) {
    if (hostDisposed) return { ok: false, error: '插件宿主已关闭' };
    if (!contract.isValidPluginId(pluginId)) return { ok: false, error: `插件 id 非法：${JSON.stringify(pluginId)}` };
    const record = plugins.get(pluginId);
    if (!record) return { ok: false, error: `插件未加载：${pluginId}` };
    if (record.state !== 'ready') {
      return { ok: false, error: `插件不可用（state=${record.state}${record.error ? '：' + record.error : ''}）` };
    }
    const implemented = record.mode === 'worker'
      ? !!(record.has && record.has[method])
      : typeof (record.module && record.module[method]) === 'function';
    if (!implemented) {
      return { ok: false, error: `插件未实现 ${method}()：${pluginId}` };
    }
    return { ok: true, record };
  }

  /**
   * 取某插件某轨道种类的音色列表。
   * @param {string} pluginId
   * @param {string} [kindId]
   * @returns {Promise<{success:boolean, voices?:object[], error?:object}>}
   */
  async function getVoices(pluginId, kindId) {
    const resolved = resolveCallable(pluginId, 'getVoices');
    if (!resolved.ok) return { success: false, error: toPluginError(resolved.error, 'PLUGIN_NOT_READY') };
    const record = resolved.record;
    if (!record.capabilities.voices) {
      return { success: false, error: toPluginError(`插件未声明音色能力：${pluginId}`, 'PLUGIN_CAPABILITY_MISSING') };
    }
    try {
      const raw = record.mode === 'worker'
        ? await callInWorker(record, 'getVoices', [kindId || null], { timeoutMs: callTimeoutMs })
        : await withTimeout(
          record.module.getVoices(kindId || null),
          callTimeoutMs,
          `${pluginId}.getVoices`,
        );
      return { success: true, voices: normalizeVoices(raw) };
    } catch (err) {
      log('error', pluginId, `getVoices 失败：${describeError(err)}`);
      return { success: false, error: toPluginError(err, 'PLUGIN_GET_VOICES_FAILED') };
    }
  }

  /**
   * 插件合成。options 原样（同一引用）交给插件。
   *
   * @param {object} request
   * @param {string} request.pluginId
   * @param {string} [request.kindId]
   * @param {string} [request.trackId]
   * @param {Array}  [request.notes]
   * @param {number} [request.bpm]
   * @param {object} [request.options]  ★ 完整 options，同一引用，不克隆
   * @param {object} [request.params]   插件自定义参数（会经 resolvePluginParams）
   * @param {string} [request.voiceId]
   * @param {number} [request.sampleRate]
   * @param {Float32Array} [request.scratch]
   * @param {object} [request.sender]  事件推送目标（event.sender / BrowserWindow）
   * @param {number} [request.timeoutMs]
   * @returns {Promise<{success:boolean, pcm?, channels?, sampleRate?, leadingSamples?, diagnostics?, error?}>}
   */
  async function synthesize(request) {
    const req = request || {};
    const pluginId = req.pluginId;
    const resolved = resolveCallable(pluginId, 'synthesize');
    if (!resolved.ok) return { success: false, error: toPluginError(resolved.error, 'PLUGIN_NOT_READY') };
    const record = resolved.record;
    if (!record.capabilities.synthesize) {
      return { success: false, error: toPluginError(`插件未声明合成能力：${pluginId}`, 'PLUGIN_CAPABILITY_MISSING') };
    }

    const sampleRate = Number.isFinite(req.sampleRate) ? req.sampleRate : DEFAULT_SAMPLE_RATE;
    const kind = findTrackKind(record, req.kindId);
    const params = contract.resolvePluginParams(
      kind ? kind.paramSchema : [],
      kind ? kind.defaults : {},
      req.params,
    );

    const controller = new AbortController();
    const call = {
      sender: req.sender || null,
      tickets: new Set(),
      controller,
      cancelled: false,
    };
    const host = makeHostApi(record, call);

    const pluginRequest = {
      kindId: kind ? kind.id : (req.kindId || null),
      pluginId: record.id,
      trackId: req.trackId || null,
      notes: req.notes,
      bpm: req.bpm,
      // ★ 全量参数透传：这里交给插件的就是调用方手上那一个对象，不做克隆、
      //   不做字段挑选，Float32Array 成员（refAudioWavBuffer / pitchCurveF0 /
      //   refF0Data）保持同一份实例。代价是插件可以改写它 —— 调用方若还要
      //   把同一 options 交给内置 pipeline，必须自行浅拷贝（svsIpc 的做法是
      //   插件分支直接 return，绝不再走内置 pipeline）。
      options: req.options,
      params,
      voiceId: req.voiceId || null,
      sampleRate,
      scratch: req.scratch || undefined,
      abortSignal: controller.signal,
    };

    const timeoutMs = Number.isFinite(req.timeoutMs) ? req.timeoutMs : callTimeoutMs;
    try {
      let raw;
      if (record.mode === 'worker') {
        // ticket id 必须让插件**同步**拿到（`ticket.id` 没法跨线程异步等），所以
        // 在调用开始前一次性把配额内的 id 分配好下发。
        const ticketPool = [];
        for (let i = 0; i < MAX_TICKETS_PER_CALL; i++) ticketPool.push(`pt-${++ticketSeq}`);
        raw = await callInWorker(record, 'synthesize', [pluginRequest, wire.hostSlot()], {
          timeoutMs,
          call,
          ticketPool,
        });
      } else {
        // ⚠️ in-process：这个 withTimeout 只能拦住"插件异步不返回"，拦不住同步忙等
        raw = await withTimeout(
          record.module.synthesize(pluginRequest, host),
          timeoutMs,
          `${pluginId}.synthesize`,
        );
      }
      const normalized = normalizeSynthResult(raw, sampleRate);
      return {
        success: true,
        pluginId: record.id,
        pcm: normalized.pcm,
        channels: normalized.channels,
        sampleRate: normalized.sampleRate,
        leadingSamples: normalized.leadingSamples,
        diagnostics: normalized.diagnostics,
      };
    } catch (err) {
      log('error', pluginId, `synthesize 失败：${describeError(err)}`);
      return { success: false, error: toPluginError(err, 'PLUGIN_SYNTHESIZE_FAILED') };
    } finally {
      // 兜底：插件忘记 end() 的 ticket 在这里统一收尾，UI 不会永久卡住。
      endCallTickets(call);
    }
  }

  /**
   * 取消某个阻滞 ticket（cancellable 的 ticket 才能被取消）。
   * 取消后插件侧通过 host.isCancelled() / request.abortSignal 感知。
   * @param {string} ticketId
   */
  function requestTicketCancel(ticketId) {
    const ticket = tickets.get(ticketId);
    if (!ticket) return { success: false, error: 'ticket 不存在或已结束' };
    if (!ticket.cancellable) {
      return { success: false, error: '该阻滞不可取消' };
    }
    ticket.cancelled = true;
    // 让插件立即感知：host.isCancelled() → true，request.abortSignal 也会 abort。
    if (ticket.callRef) {
      ticket.callRef.cancelled = true;
      // worker 模式下插件在另一个线程里，必须显式通知：它那边只有这条消息才能
      // 把 host.isCancelled() / request.abortSignal.aborted 翻成 true。
      const callRef = ticket.callRef;
      const recordRef = callRef.recordRef;
      if (recordRef && recordRef.mode === 'worker' && recordRef.worker && callRef.callId) {
        try {
          recordRef.worker.postMessage({ type: 'cancel', callId: callRef.callId });
        } catch (_) { /* worker 已经没了就无所谓 */ }
      }
      try {
        if (ticket.callRef.controller && !ticket.callRef.controller.signal.aborted) {
          ticket.callRef.controller.abort();
        }
      } catch (_) { /* Node 旧版本无 AbortController 语义差异，忽略 */ }
    }
    endTicket(ticket, 'cancelled');
    log('info', ticket.pluginId, `ticket ${ticketId} 已被请求取消`);
    return { success: true, ticketId };
  }

  /** 插件读取模型/素材文件前的统一校验入口：不通过返回明确错误。 */
  function checkPathAllowed(filePath) {
    if (!security.isPathAllowed(filePath)) {
      return { allowed: false, error: `路径未被授权（插件只能访问已授权目录）：${filePath}` };
    }
    return { allowed: true };
  }

  return {
    pluginsDir,
    listPlugins,
    loadPlugins,
    reloadPlugins,
    getVoices,
    synthesize,
    requestTicketCancel,
    checkPathAllowed,
    dispose,
    /** 测试/调试用：内部记录（只读快照，不含 module 引用） */
    _snapshot() {
      return [...plugins.values()].map((r) => ({
        id: r.id,
        state: r.state,
        error: r.error,
        mode: r.mode,
        workerAlive: !!r.worker,
        capabilities: { ...r.capabilities },
        trackKinds: r.trackKinds.map((k) => k.id),
      }));
    },
  };
}

/**
 * 在已加载插件里找轨道种类声明。
 * @param {object} record
 * @param {string} [kindId]
 */
function findTrackKind(record, kindId) {
  if (!kindId) return record.trackKinds.length === 1 ? record.trackKinds[0] : null;
  return record.trackKinds.find((k) => k.id === kindId) || null;
}

/**
 * 归一化 getVoices 返回值：只保留 {id, name, tags, sampleRate}。
 * @param {unknown} raw
 */
function normalizeVoices(raw) {
  if (!Array.isArray(raw)) throw new Error('getVoices() 必须返回数组');
  if (raw.length > contract.PLUGIN_MAX_VOICES) {
    throw new Error(`音色数量超过上限 ${contract.PLUGIN_MAX_VOICES}`);
  }
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error('音色条目必须是对象');
    if (typeof item.id !== 'string' || !item.id) throw new Error('音色条目缺少 id');
    out.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name ? item.name : item.id,
      tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string') : [],
      sampleRate: Number.isFinite(item.sampleRate) ? item.sampleRate : null,
    });
  }
  return out;
}

// -------------------------------------------------------------------------
// 进程内单例（IPC 层用）
// -------------------------------------------------------------------------

let _singleton = null;

/** 取得进程内共享的插件宿主（首次调用时按默认规则创建）。 */
function getPluginHost() {
  if (!_singleton) _singleton = createPluginHost();
  return _singleton;
}

/** 丢弃单例（测试 / 插件目录变更时使用）。 */
function resetPluginHost() {
  const old = _singleton;
  _singleton = null;
  if (old) Promise.resolve(old.dispose()).catch(() => {});
}

module.exports = {
  createPluginHost,
  getPluginHost,
  resetPluginHost,
  // 导出纯函数便于单测
  validateManifest,
  validateModule,
  normalizeSynthResult,
  normalizeVoices,
  validatePcmArray,
  findNonFiniteIndex,
  applyTicketUpdate,
  isInside,
  withTimeout,
  MIN_SAMPLE_RATE,
  MAX_SAMPLE_RATE,
  DEFAULT_SAMPLE_RATE,
  EXECUTION_MODES,
  MAX_PCM_DURATION_SEC,
  MAX_PCM_BYTES,
  TICKET_UPDATE_THROTTLE_MS,
  TICKET_UPDATE_PROGRESS_EPSILON,
  MAX_CONSECUTIVE_TIMEOUTS,
};
