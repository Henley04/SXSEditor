/**
 * 插件音频边界回归：PCM 类型归一化 / 声道校验 / 采样率统一 / leadingSamples 上限。
 * 这些值由第三方插件直接返回，不能让异常值逃逸到混音与主进程内存分配。
 */
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const { toBuiltinAudio } = require('../src/main/pluginIpc.js');

describe('插件音频归一化', () => {
  it('Float32Array / ArrayBuffer / 普通数组都能归一化为 Float32Array', () => {
    const cases = [
      new Float32Array([0.1, -0.1]),
      new Float32Array([0.1, -0.1]).buffer,
      [0.1, -0.1],
      new Float64Array([0.1, -0.1]),
    ];
    for (const pcm of cases) {
      const r = toBuiltinAudio({ pcm, channels: 1, sampleRate: 24000 }, 24000);
      expect(r.ok, `PCM 类型 ${Object.prototype.toString.call(pcm)} 应被接受`).to.equal(true);
      expect(r.audio).to.be.instanceOf(Float32Array);
      expect(r.audio.length).to.equal(2);
      expect(r.audio[0]).to.be.closeTo(0.1, 1e-6);
    }
  });

  it('平面声道按平均下混，不再只取第 0 声道', () => {
    const r = toBuiltinAudio({
      pcm: [new Float32Array([1, 1]), new Float32Array([0, 0])],
      channels: 2,
      sampleRate: 24000,
    }, 24000);
    expect(r.ok).to.equal(true);
    expect([...r.audio]).to.deep.equal([0.5, 0.5]);
  });

  it('channels 非法或交错长度不整除时明确失败', () => {
    for (const channels of [0, -1, 1.5, Infinity, '2', 33]) {
      const r = toBuiltinAudio({
        pcm: new Float32Array(4), channels, sampleRate: 24000,
      }, 24000);
      expect(r.ok, `channels=${channels} 必须被拒绝`).to.equal(false);
    }
    const r = toBuiltinAudio({
      pcm: new Float32Array(5), channels: 2, sampleRate: 24000,
    }, 24000);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/不能被声道数/);
  });

  it('采样率不匹配时重采样到工程采样率，时长语义保持正确', () => {
    const r = toBuiltinAudio({
      pcm: new Float32Array(48000).fill(0.5), channels: 1, sampleRate: 48000,
    }, 24000);
    expect(r.ok).to.equal(true);
    expect(r.sampleRate).to.equal(24000);
    expect(r.audio.length).to.equal(24000); // 1 秒 @48k → 1 秒 @24k
  });

  it('leadingSamples 为负或超大时拒绝，不再静默分配巨额 buffer', () => {
    expect(toBuiltinAudio({
      pcm: new Float32Array(2), channels: 1, sampleRate: 24000, leadingSamples: -1,
    }, 24000).ok).to.equal(false);
    expect(toBuiltinAudio({
      pcm: new Float32Array(2), channels: 1, sampleRate: 24000, leadingSamples: Number.MAX_SAFE_INTEGER,
    }, 24000).ok).to.equal(false);
  });
});

describe('第三轮修复静态契约', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('WebNN 响应用 send/once，而不是 invoke/handleOnce', () => {
    const main = read('src/main/webnnIpc.js');
    const bridge = read('src/inference/pipeline/webnnIpc.js');
    const preload = read('src/preload.js');
    expect(preload).to.include('ipcRenderer.send(responseChannel, result)');
    expect(main).not.to.match(/ipcMain\.handleOnce\(responseChannel/);
    expect(main).to.match(/ipcMain\.once\(responseChannel/);
    expect(bridge).to.match(/ipcMain\.once\(responseChannel/);
    expect(bridge).to.include('chunkEndSeen');
  });

  it('Worker 支持预取消并把 chunk 统一为 Float32Array', () => {
    const src = read('src/inference/svsWorker.js');
    expect(src).to.include('pendingCancelledIds');
    expect(src).to.include('registerController');
    expect(src).to.include('data: { ...data, audio: pcm }');
  });
});
