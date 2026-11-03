'use strict';

/**
 * pipeline hook 示例：50ms 淡入 + 整体 -3dB。
 *
 * 三条约束（文档 §9 有同样的说明）：
 *   1. **必须返回同样长度的 Float32Array**。改变样本数会让音频与视频/伴奏错位，
 *      宿主会直接拒绝并记一次失败，不会采用你的结果。
 *   2. **不要在这里做重活**。hook 跑在插件进程里，音频要跨进程复制一次；
 *      想跑 ONNX 就声明 `kind: 'model'`，让张量留在推理进程里。
 *   3. **失败不会拖垮合成**。抛异常或超时 → 宿主跳过你继续出音频，连续 3 次熔断。
 *
 * 这个 hook 没有命令、没有面板、没有菜单：装上就应该听得出差别。
 */

module.exports = {
  initialize(ctx) {
    ctx.log.info('pipeline hook 就绪：postWaveform/soften（50ms 淡入 + -3dB）');
  },

  pipelineHooks: {
    soften(ctx, { audio, sampleRate }) {
      if (!(audio instanceof Float32Array)) return audio;
      const out = new Float32Array(audio.length);
      const fade = Math.max(1, Math.min(audio.length, Math.round(sampleRate * 0.05)));
      for (let i = 0; i < audio.length; i++) {
        const g = i < fade ? (i / fade) * 0.7079 : 0.7079;
        out[i] = audio[i] * g;
      }
      return out;
    },
  },
};
