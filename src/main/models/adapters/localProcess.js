'use strict';

/**
 * 本地推理（进程内 / 本机 worker）的 adapter。
 *
 * 它不碰网络：网关把端点解析成 `local-process` 之后，这里转交给宿主注册的后端
 * （`synthesis.backend` 的既有实现，或或某个本地 ONNX 生成器）。数据不出机器，
 * 因此这类端点默认免确认（locality = device）。
 *
 * 关于背压：本地推理通常是**原子**的（一次 fortran 调用跑完才出结果），没有中间
 * 状态可以暂停。所以这里**不提供 pause/resume** —— 网关会把它识别为"不可暂停的
 * 通道"，在缓冲超限时明确失败（BACKPRESSURE_OVERFLOW），而不是假装暂停或者
 * 静默丢数据。
 */

const { ERR } = require('../../../shared/modelContract');

/**
 * @param {{backends?:Map<string, object>, logger?:object}} [opts]
 */
function createLocalProcessAdapter(opts = {}) {
  const backends = opts.backends || new Map();

  return {
    name: 'local-process',

    /** 供第 2 段接线：把 synthesis.backend 或本地生成器挂进来。 */
    register(localId, impl) {
      backends.set(localId, impl);
    },

    async invoke(ctx, emit) {
      const { endpoint, task, input, signal, model } = ctx;
      const key = endpoint.localBackend || endpoint.id;
      const impl = backends.get(key) || backends.get(endpoint.id);
      if (!impl || typeof impl.run !== 'function') {
        const err = new Error(`本地后端未注册：${key}`);
        err.code = ERR.ENDPOINT_UNAVAILABLE;
        throw err;
      }
      if (signal.aborted) {
        const err = new Error('已取消');
        err.code = ERR.CANCELLED;
        throw err;
      }
      const result = await impl.run({ task, input, model, signal, endpoint });
      // 文本类结果按 chunk 发；二进制（音频/MIDI）交给调用方的 handle 存储，
      // 由上层决定内联还是落盘 —— adapter 不碰这两条路径的选择。
      if (typeof result === 'string') {
        emit('chunk', { data: result, bytes: Buffer.byteLength(result, 'utf8') });
      } else if (result && result.text != null) {
        emit('chunk', { data: String(result.text), bytes: Buffer.byteLength(String(result.text), 'utf8') });
      } else if (result && result.binary) {
        emit('progress', { binary: true, size: result.binary.length, mime: result.mime || 'application/octet-stream' });
        emit('chunk', { data: '', bytes: 0, binary: result.binary, mime: result.mime });
      }
    },
  };
}

module.exports = { createLocalProcessAdapter };
