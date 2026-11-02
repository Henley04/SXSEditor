'use strict';
/**
 * 插件 runtime 的 ORT 封装。
 *
 * 与内置管线的区别：这里没有 session key 白名单、没有 dummy 输入表，任何 ONNX 都能加载。
 * 设备选择由宿主在 init 时下发的 policy 决定（插件不得自己指定任意 deviceId）：
 *   · 允许 dml → 先试 DML（可带 deviceId），失败回落 CPU；
 *   · 只允许 cpu → 直接 CPU；
 *   · 每次加载都记日志，便于用户在管理器里看到"这个插件到底跑在哪"。
 */
const path = require('node:path');

let _ort = null;
function ort() {
  if (_ort) return _ort;
  // 与 src/inference/ortRuntime.js 同样的惰性策略：只有真的要用 ORT 才占内存
  _ort = require('onnxruntime-node');
  return _ort;
}

function resolveFirst(candidates) {
  const fs = require('node:fs');
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return require(c);
    } catch (_) {
      // 继续尝试下一个候选；全部失败时抛出最后一个错误更有信息量
    }
  }
  throw new Error(`找不到模块：${candidates.join(' | ')}`);
}

function sessionOptionsFactory() {
  // 复用内置的选项构造器；源码运行与打包运行的目录深度不同，按候选路径探测
  const mod = resolveFirst([
    path.join(__dirname, '..', '..', '..', 'inference', 'shared', 'ortOptions.js'),
    path.join(__dirname, '..', '..', 'inference', 'shared', 'ortOptions.js'),
  ]);
  return mod.buildSessionOptions;
}

const DTYPE_TO_TYPED = {
  float32: 'Float32Array',
  float16: 'Float16Array',
  int64: 'BigInt64Array',
  int32: 'Int32Array',
  uint8: 'Uint8Array',
  bool: 'Uint8Array',
};

class OrtRunner {
  /**
   * @param {{allowedEps?: string[], deviceId?: number, log?: Function}} opts
   */
  constructor(opts = {}) {
    this.allowedEps = Array.isArray(opts.allowedEps) ? opts.allowedEps : ['cpu'];
    this.deviceId = Number.isFinite(opts.deviceId) ? opts.deviceId : undefined;
    this.log = opts.log || (() => {});
    this.sessions = new Map();
    this._seq = 0;
    this._buildOptions = null;
  }

  buildOptions(eps) {
    if (!this._buildOptions) this._buildOptions = sessionOptionsFactory();
    return this._buildOptions({ executionProviders: eps });
  }

  /**
   * 加载模型。modelPath 必须是插件目录内的相对路径（由宿主校验过 manifest 的同类约束）。
   * @returns {Promise<{handle:string, inputs:Array, outputs:Array, ep:string}>}
   */
  async load(modelPath, options = {}) {
    const requested = options.ep || (this.allowedEps.includes('dml') ? 'dml' : 'cpu');
    if (requested !== 'cpu' && !this.allowedEps.includes(requested)) {
      throw new Error(`未获授权的执行后端：${requested}（允许：${this.allowedEps.join(', ') || '无'}）`);
    }

    const attempts = [];
    if (requested === 'dml') {
      const ep = Number.isFinite(this.deviceId) ? { name: 'dml', deviceId: this.deviceId } : 'dml';
      attempts.push({ eps: [ep], label: 'dml' });
    }
    attempts.push({ eps: ['cpu'], label: 'cpu' });

    let session = null;
    let used = 'cpu';
    let lastErr = null;
    for (const attempt of attempts) {
      try {
        session = await ort().InferenceSession.create(modelPath, this.buildOptions(attempt.eps));
        used = attempt.label;
        break;
      } catch (err) {
        lastErr = err;
        this.log('warn', `[ort] ${attempt.label} 加载失败，尝试下一个后端：${err && err.message}`);
      }
    }
    if (!session) throw lastErr || new Error('模型加载失败');

    const handle = `s${++this._seq}`;
    this.sessions.set(handle, { session, modelPath, ep: used });
    this.log('info', `[ort] 已加载 ${path.basename(modelPath)}（${used}）`);
    return {
      handle,
      ep: used,
      inputs: session.inputNames.map((name) => {
        const meta = (session.inputMetadata || []).find((m) => m.name === name);
        return { name, type: (meta && meta.type) || 'float32', dims: (meta && meta.shape) || null };
      }),
      outputs: session.outputNames.map((name) => ({ name })),
    };
  }

  async run(handle, feeds, options = {}) {
    const entry = this.sessions.get(handle);
    if (!entry) throw new Error(`未知的 session：${handle}`);

    const tensors = {};
    for (const [name, spec] of Object.entries(feeds || {})) {
      if (!spec || typeof spec !== 'object') throw new Error(`输入 ${name} 格式非法`);
      const type = spec.type || 'float32';
      const dims = Array.isArray(spec.dims) ? spec.dims.map(Number) : null;
      if (!dims || dims.some((d) => !Number.isFinite(d) || d < 0)) {
        throw new Error(`输入 ${name} 缺少合法 dims`);
      }
      const data = spec.data;
      if (!data) throw new Error(`输入 ${name} 缺少 data`);
      const typed = DTYPE_TO_TYPED[type];
      if (!typed) throw new Error(`输入 ${name} 的类型不受支持：${type}`);
      tensors[name] = new (ort().Tensor)(type, data, dims);
    }

    const started = Date.now();
    const results = await entry.session.run(tensors, options.outputNames || null);
    const elapsed = Date.now() - started;

    const out = {};
    for (const [name, tensor] of Object.entries(results)) {
      out[name] = {
        type: tensor.type,
        dims: [...tensor.dims],
        data: tensor.data,
      };
    }
    this.log('debug', `[ort] run ${handle} ${elapsed}ms`);
    return out;
  }

  async unload(handle) {
    this.sessions.delete(handle);
  }

  async dispose() {
    this.sessions.clear();
    // ORT 的 session 没有显式 dispose；释放引用 + GC 即可（utilityProcess 被杀时一并回收）
  }
}

module.exports = { OrtRunner, resolveFirst };
