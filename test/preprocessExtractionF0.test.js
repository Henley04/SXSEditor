/**
 * 音频预处理（歌手预处理）提取流程的两条硬约定：
 *
 * 1. F0 归属：RMVPE 是专用 F0 提取器，FCPE / Basic Pitch 的 F0 只用于切分音符。
 *    先「RMVPE提取F0」再「提取MIDI」时，FCPE 的 F0 不得覆盖 RMVPE 的结果
 *    （此前会被整条顶掉，曲线形状完全不同）。
 *
 * 2. 进度不许提前结束：真实推理是一次性 IPC，没有中途回调，占位进度必须停在
 *    上限之下，只有拿到结果并绘制完成后才到 100%。此前是 5 个固定档位 × 260ms，
 *    1.3 秒就冲到 96%，音频稍长就是"进度转圈比实际结果更早结束"。
 */

const assert = require('node:assert');

function buildDom() {
  document.body.innerHTML = `
    <span id="midi-info"></span>
    <div id="extract-status"></div>
    <div id="extract-panel">
      <div id="extract-panel-body">
        <select id="preset-select"><option value="custom">custom</option></select>
        <select id="threshold-select">
          <option value="low">low</option><option value="mid">mid</option><option value="high">high</option>
        </select>
        <select id="smoothing-select">
          <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
        </select>
        <select id="quantization-select">
          <option value="strict">strict</option><option value="pitchbend">pitchbend</option>
        </select>
        <input type="checkbox" id="range-auto" />
        <input type="number" id="f0-min" value="80" />
        <input type="number" id="f0-max" value="880" />
        <input type="number" id="min-note" value="0.05" />
        <input type="checkbox" id="bpm-auto" />
        <input type="number" id="bpm-input" value="120" />
        <input type="checkbox" id="normalize-check" checked />
        <div id="fcpe-params-notice"></div>
      </div>
    </div>
  `;
  document.getElementById('threshold-select').value = 'mid';
  document.getElementById('smoothing-select').value = 'medium';
  document.getElementById('quantization-select').value = 'strict';
}

function makeF0(count, freq) {
  const out = [];
  for (let i = 0; i < count; i++) out.push({ time: i * 0.01, f0: freq, confidence: 0 });
  return out;
}

function fakeAudioBuffer(duration = 2) {
  const samples = new Float32Array(1024);
  return {
    duration,
    sampleRate: 44100,
    length: samples.length,
    getChannelData: () => samples,
  };
}

describe('preprocess extraction — F0 ownership & progress', () => {
  let state;
  let initDomRefs;
  let midiExtraction;

  before(async () => {
    // 渲染进程里 rAF 是全局的；jsdom 只挂在 window 上。
    if (typeof global.requestAnimationFrame !== 'function') {
      global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
      global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
    }
    ({ state, initDomRefs } = await import('../src/audioPreprocess/state.js'));
    midiExtraction = await import('../src/audioPreprocess/midiExtraction.js');
  });

  beforeEach(() => {
    buildDom();
    initDomRefs();
    state.wavAudioBuffer = fakeAudioBuffer();
    state.wavDuration = 2;
    state.trimOffsetSec = 0;
    state.f0Data = null;
    state.f0Source = null;
    state.pianoRoll = {
      notes: [],
      bpm: 120,
      f0Data: null,
      _staticCacheDirty: false,
      render() {},
    };
  });

  afterEach(() => {
    state.wavAudioBuffer = null;
    state.wavDuration = 0;
    state.f0Data = null;
    state.f0Source = null;
    state.pianoRoll = null;
    document.body.innerHTML = '';
  });

  function mockFcpe(resultFactory) {
    window.electronAPI = {
      getSettings: async () => ({ midiExtractTool: 'fcpe' }),
      extractMidiFcpe: resultFactory,
      savePreprocessData: async () => true,
    };
  }

  it('已有 RMVPE F0 时，FCPE 只生成音符、不覆盖 F0', async () => {
    const rmvpeF0 = makeF0(200, 220);
    state.f0Data = rmvpeF0;
    state.f0Source = 'rmvpe';

    mockFcpe(async () => ({
      success: true,
      device: 'CPU',
      bpm: 120,
      f0Array: makeF0(200, 330), // CPE 自己的曲线，频率完全不同
      notes: [
        { pitch: 60, start: 0, duration: 1 },
        { pitch: 62, start: 1, duration: 1 },
      ],
      warnings: [],
    }));

    await midiExtraction.extractF0BasicPitch();

    assert.strictEqual(state.f0Data, rmvpeF0, 'F0 必须原样保留（不得被 FCPE 顶掉）');
    assert.strictEqual(state.f0Source, 'rmvpe');
    assert.strictEqual(state.pianoRoll.f0Data, rmvpeF0);
    assert.strictEqual(state.pianoRoll.notes.length, 2, '音符应当照常更新');
    // singerData.f0 也必须是 RMVPE 的曲线
    assert.ok(state.singerData.f0.startsWith('220.0 220.0'), `singerData.f0 应为 RMVPE 值，实际 ${state.singerData.f0.slice(0, 20)}`);
  });

  it('没有 RMVPE 结果时，采用本次提取到的 F0', async () => {
    mockFcpe(async () => ({
      success: true,
      device: 'CPU',
      bpm: 120,
      f0Array: makeF0(200, 330),
      notes: [{ pitch: 60, start: 0, duration: 1 }],
      warnings: [],
    }));

    await midiExtraction.extractF0BasicPitch();

    assert.ok(Array.isArray(state.f0Data) && state.f0Data.length > 0, '应当采用 FCPE 的 F0');
    assert.strictEqual(state.f0Data[0].f0, 330);
    assert.strictEqual(state.f0Source, 'fcpe');
  });

  it('占位进度在结果返回前不会跑满，结束后遮罩才撤', async () => {
    const fake0 = makeF0(200, 220);
    state.f0Data = fake0;

    // 1.4 秒才返回结果：旧实现 1.3 秒就已经到 96%
    mockFcpe(() => new Promise((resolve) => {
      setTimeout(() => resolve({
        success: true,
        device: 'CPU',
        bpm: 120,
        f0Array: makeF0(200, 220),
        notes: [{ pitch: 60, start: 0, duration: 1 }],
        warnings: [],
      }), 1400);
    }));

    const pending = midiExtraction.extractF0BasicPitch();
    await new Promise((r) => setTimeout(r, 1350));

    const overlay = document.querySelector('.loading-overlay');
    assert.ok(overlay, '结果没回来之前遮罩必须还在');
    const fill = overlay.querySelector('.loading-progress-fill');
    const pct = parseFloat(fill.style.width);
    assert.ok(pct > 0, `进度应已开始推进，实际 ${fill.style.width}`);
    assert.ok(pct < 90, `结果未返回时进度不得跑满（上限 90%），实际 ${pct}%`);
    const eta = overlay.querySelector('.loading-eta').textContent;
    // 副标题只允许出现"已用 X.Xs"，不得再出现凭空外推的"预计剩余/ETA"。
    assert.match(eta, /\d+\.\d+s/, `副标题应显示真实已用时间，实际 "${eta}"`);
    assert.doesNotMatch(eta, /预计剩余|ETA/, `不得再显示外推的剩余时间，实际 "${eta}"`);

    await pending;

    assert.strictEqual(document.querySelector('.loading-overlay'), null, '完成后遮罩必须撤掉');
    assert.strictEqual(state.pianoRoll.notes.length, 1);
  });
});
