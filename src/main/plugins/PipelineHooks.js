'use strict';

/**
 * pipeline hook 的执行器（宿主侧）。
 *
 * 三个阶段：`preEncoder`（音符序列，合成前）、`postMel`（mel 频谱）、
 * `postWaveform`（波形）。本文件只执行 `kind: 'js'` 且 stage 为 `postWaveform`
 * 的 hook —— 另外两种要么需要张量留在 svsWorker 的 ORT 里（`kind: 'model'`），
 * 要么需要管线在中间态暴露可序列化数据（`postMel`），都会在后续单独接线。
 *
 * 三条硬规则：
 *   1. **hook 失败不拖垮合成**。做后处理的插件挂一次，用户的歌还得唱出来；
 *      失败的 hook 记日志并跳过，连续失败 3 次熔断，直到插件重载。
 *   2. **不许改长度**。后处理 hook 只做滤波/去咔哒/增益，改变样本数会让
 *      时间轴与视频/伴奏错位 —— 那种错位用户很难归因到插件。
 *   3. **按 order 稳定排序**。同 order 按 pluginId 排，避免两次启动顺序不同
 *      导致导出结果不一致。
 */

const MAX_CONSECUTIVE_FAILS = 3;

class PipelineHooks {
  /**
   * @param {{service:object, logger?:object}} opts service 需要 registry 与 callPipelineHook
   */
  constructor(opts) {
    this.service = opts.service;
    this.log = opts.logger || console;
    /** @type {Map<string, number>} `${pluginId}.${hookId}` → 连续失败次数 */
    this._fails = new Map();
    this._disabledHooks = new Set();
  }

  /**
   * 收集当前生效的 js hook。
   *
   * 从**注册表**读而不是从 manifest 读：停用/重载过程中 manifest 还在 record 上，
   * 但贡献表已经撤销。按 manifest 读会调用一个已经不存在的插件 —— 表现为
   * 每次合成多等一次超时。注册表已经是按 stage 过滤 + order/pluginId 稳定排序的。
   */
  collect(stage) {
    let rows = [];
    try {
      rows = this.service.registry.hooksFor(stage);
    } catch (_) {
      return [];
    }
    return rows.filter((h) => h && h.kind === 'js' && h.hook);
  }

  /**
   * 依次执行，返回处理后的波形。
   * @param {string} stage
   * @param {Float32Array} audio
   * @param {{sampleRate:number, bpm?:number}} meta
   * @returns {Promise<Float32Array>}
   */
  async run(stage, audio, meta = {}) {
    if (!(audio instanceof Float32Array)) return audio;
    const hooks = this.collect(stage);
    if (!hooks.length) return audio;

    let cur = audio;
    for (const h of hooks) {
      const key = `${h.pluginId}.${h.hook}`;
      if (this._disabledHooks.has(key)) continue;
      try {
        const res = await this.service.callPipelineHook(h.pluginId, h.hook, {
          stage,
          audio: cur,
          sampleRate: meta.sampleRate,
          bpm: meta.bpm,
        }, h.timeoutMs);
        const next = res instanceof Float32Array ? res : (res && res.audio);
        if (!(next instanceof Float32Array) || next.length === 0) {
          throw new Error('hook 没有返回 Float32Array');
        }
        // 长度必须保持：改变样本数 = 时间轴错位，且这类问题极难归因
        if (next.length !== cur.length) {
          throw new Error(`hook 改变了样本数（${cur.length} → ${next.length}）`);
        }
        cur = next;
        this._fails.delete(key);
      } catch (err) {
        const fails = (this._fails.get(key) || 0) + 1;
        this._fails.set(key, fails);
        this.log.warn(`[plugins] pipeline hook ${key} 失败（第 ${fails} 次）：${err && err.message}`);
        if (fails >= MAX_CONSECUTIVE_FAILS) {
          this._disabledHooks.add(key);
          this.log.warn(`[plugins] pipeline hook ${key} 连续失败，本次运行内停用`);
        }
      }
    }
    return cur;
  }

  /** 插件重载后重置熔断状态：换了代码就该再给一次机会。 */
  reset() {
    this._fails.clear();
    this._disabledHooks.clear();
  }

  /** 供管理界面展示。 */
  snapshot() {
    return this.collect('postWaveform').map((h) => ({
      pluginId: h.pluginId,
      hook: h.hook,
      stage: h.stage,
      order: h.order,
      disabled: this._disabledHooks.has(`${h.pluginId}.${h.hook}`),
      fails: this._fails.get(`${h.pluginId}.${h.hook}`) || 0,
    }));
  }
}

/** pipeline 模块级注入点。不要在这里 require 插件系统：管线要能独立单测。 */
let _runner = null;

function setPipelineHookRunner(fn) {
  _runner = typeof fn === 'function' ? fn : null;
}

/**
 * 由管线在返回音频前调用。没有注入执行器时原样返回 —— 单测与 CLI 走的就是这条。
 * @param {Float32Array} audio
 * @param {{sampleRate:number, bpm?:number}} meta
 */
async function applyPipelineHooks(stage, audio, meta) {
  if (!_runner) return audio;
  try {
    return await _runner(stage, audio, meta);
  } catch (err) {
    console.warn('[pipeline] hook 执行器异常：', err && err.message);
    return audio;
  }
}

module.exports = { PipelineHooks, setPipelineHookRunner, applyPipelineHooks };
