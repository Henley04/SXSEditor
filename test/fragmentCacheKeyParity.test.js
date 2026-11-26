/**
 * 分片编辑器与主窗口的合成缓存必须"同键"。
 *
 * 背景（用户报告："实际有缓存但复用不成功"）：
 *   主窗口的 options 带 `modelPrecision: 'fp32'|'fp16'|'int8'`，主进程把它折进
 *   缓存键的 `pm` 段；分片编辑器此前**不传**，缺省落成 `pmbase` —— 同一分片、
 *   同一输入，两边键永远不相等，全局缓存一次也命不中，编辑器每次播放都整段重推。
 *
 * 本文件钉住两件事：
 *   1. `getFragmentPreviewInferenceOptions()` 必须下发精度（以及采样器/Q-Drift）；
 *   2. 渲染层复用签名必须随这些参数变化（否则"改了设置仍播旧音频"）。
 */
const { expect } = require('chai');

// computeFragmentAudioSignature 依赖 i18n / DOM 的最小面
if (!global.window) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost' });
  global.window = dom.window;
  global.document = dom.window.document;
}
if (!document.getElementById('autoShiftCheck')) {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.id = 'autoShiftCheck';
  document.body.appendChild(el);
}
// canvasRenderer 在模块加载期就取 canvas 上下文
for (const id of ['piano-roll', 'piano-keys', 'param-roll', 'velocity-roll', 'pitch-roll']) {
  if (!document.getElementById(id)) {
    const c = document.createElement('canvas');
    c.id = id;
    document.body.appendChild(c);
  }
}

const state = require('../src/fragmentEditor/state.js');
const { getFragmentPreviewInferenceOptions, getFragmentExportInferenceOptions } = require('../src/fragmentEditor/pipeline.js');
const { computeFragmentAudioSignature } = require('../src/fragmentEditor/audioPlayback.js');
const { AudioSegmentation } = require('../src/inference/pipeline/audioSegmentation');

const NOTES = [
  { id: 1, pitch: 60, start: 0, duration: 4, lyric: 'la', fadeIn: 0, fadeOut: 0 },
  { id: 2, pitch: 62, start: 4, duration: 4, lyric: 'la', fadeIn: 0, fadeOut: 0 },
];

function seedState(settings) {
  state.setSampleRate(24000);
  state.setPipelineInitialized(true);
  state.setNotes(NOTES);
  state.setCurrentProject({ bpm: 120 });
  state.setCurrentFragment({ id: 'frag1', notes: NOTES, duration: 8, singerId: 's1' });
  state.setWavFileBuffer(null);
  state.setSingerAnnotation(null);
  state.setTrackBackend({ type: 'sxs' });
  state.setFragmentAudioSettings(settings);
}

describe('分片编辑器缓存键与主窗口同口径', () => {
  it('预览/导出推理选项必须带 modelPrecision（缺省不再落成 base）', () => {
    seedState({ modelPrecision: 'fp16', previewSampler: 'euler', exportSampler: 'euler' });
    const preview = getFragmentPreviewInferenceOptions();
    const exportOpts = getFragmentExportInferenceOptions();
    expect(preview.modelPrecision).to.equal('fp16');
    expect(exportOpts.modelPrecision).to.equal('fp16');
    expect(preview.sampler).to.be.a('string');
    expect(preview.qdrift).to.be.a('boolean');

    // 直接用编辑器下发的 options 算主进程缓存键：必须与主窗口的 pm 段一致
    const seg = new AudioSegmentation();
    const key = seg.computeMelCacheKey(NOTES, 120, preview);
    expect(key).to.contain('_pmfp16');
  });

  it('精度/采样器/Q-Drift 变化都会让复用签名失效', () => {
    seedState({ modelPrecision: 'fp32', previewSampler: 'euler' });
    const base = computeFragmentAudioSignature();

    seedState({ modelPrecision: 'fp32', previewSampler: 'euler' });
    expect(computeFragmentAudioSignature(), '相同输入签名必须稳定').to.equal(base);

    seedState({ modelPrecision: 'fp16', previewSampler: 'euler' });
    expect(computeFragmentAudioSignature(), '切精度必须重推').to.not.equal(base);

    seedState({ modelPrecision: 'fp32', previewSampler: 'dpm' });
    expect(computeFragmentAudioSignature(), '换采样器必须重推').to.not.equal(base);

    seedState({ modelPrecision: 'fp32', previewSampler: 'euler', previewEnableQDrift: true });
    expect(computeFragmentAudioSignature(), 'Q-Drift 开关必须重推').to.not.equal(base);
  });
});
