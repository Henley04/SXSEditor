const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PluginDataPlane, FILE_ERR } = require('../src/main/plugins/PluginDataPlane.js');
const { authorizePath } = require('../src/main/security.js');
const { validateManifest } = require('../src/shared/pluginManifest.js');

/**
 * 音频导出器（M4 第 4 段）。
 *
 * 三组断言，各自对应一个容易出错的假设：
 *   1. 声明 —— 导出器是"成品格式"，不是工程格式；保留扩展名必须拒绝；
 *   2. 路由 —— 导出器与目标扩展名必须一致（否则等于让插件往任意后缀里写字节）；
 *   3. 形状 —— 音频必须是 Float32Array、通道数能整除采样数、采样率合理。
 *
 * 第 3 组不是洁癖：一个 `interleaved.length % channels !== 0` 的输入，交给
 * 编码器后通常不报错，只是把最后一帧截断 —— 用户拿到的是"听起来少了一点点"的文件。
 */

function baseManifest(extra = {}) {
  return {
    id: 'example-sv2',
    name: 'Example SV2',
    version: '1.0.0',
    apiVersion: 2,
    main: 'main.js',
    permissions: { fs: ['userPicked:read', 'userPicked:write'] },
    contributes: {
      exporters: [{ id: 'flac', ext: '.flac', label: { en: 'FLAC', 'zh-CN': 'FLAC' }, mime: 'audio/flac' }],
      ...extra,
    },
  };
}

function plugin(id, permissions) {
  return {
    id,
    status: 'loaded',
    manifest: {
      name: `Plugin ${id}`,
      permissions: permissions || { fs: ['userPicked:write'] },
    },
  };
}

const exporterEntry = {
  pluginId: 'p1', id: 'flac', ext: '.flac', mime: 'audio/flac',
  label: { en: 'FLAC' }, description: '',
};

describe('manifest — contributes.exporters', () => {
  it('接受最小声明并归一化', () => {
    const res = validateManifest(baseManifest());
    expect(res.ok).to.equal(true);
    expect(res.value.contributes.exporters).to.deep.equal([{
      id: 'flac', ext: '.flac', label: { en: 'FLAC', 'zh-CN': 'FLAC' },
      mime: 'audio/flac', description: '',
    }]);
  });

  it('没有点号的扩展名自动补点，大小写归一', () => {
    const res = validateManifest({
      ...baseManifest(),
      contributes: { exporters: [{ id: 'mp3', ext: 'MP3', label: { en: 'MP3' } }] },
    });
    expect(res.ok).to.equal(true);
    expect(res.value.contributes.exporters[0].ext).to.equal('.mp3');
  });

  it('拒绝工程/歌手扩展名 —— 成品不能长得像工程', () => {
    for (const ext of ['.sxsproj', '.sxs', '.sxssinger', '.sxsp']) {
      const res = validateManifest({
        ...baseManifest(),
        contributes: { exporters: [{ id: 'x', ext, label: { en: 'X' } }] },
      });
      expect(res.ok, ext).to.equal(false);
      expect(res.error).to.match(/工程|歌手/);
    }
  });

  it('拒绝非法 id / 重复 id / 非法 mime / 缺少 label', () => {
    const bad = (exporter) => validateManifest({
      ...baseManifest(),
      contributes: { exporters: [exporter] },
    });
    expect(bad({ id: 'a b', ext: '.x', label: { en: 'X' } }).ok).to.equal(false);
    expect(bad({ id: 'ok', ext: '.x' }).ok).to.equal(false);
    expect(bad({ id: 'ok', ext: '.x', label: { en: 'X' }, mime: 'not-a-mime' }).ok).to.equal(false);
    const dup = validateManifest({
      ...baseManifest(),
      contributes: {
        exporters: [
          { id: 'a', ext: '.x', label: { en: 'X' } },
          { id: 'a', ext: '.y', label: { en: 'Y' } },
        ],
      },
    });
    expect(dup.ok).to.equal(false);
    expect(dup.error).to.match(/重复/);
  });

  it('mime 可以省略（不是所有格式都有公认类型）', () => {
    const res = validateManifest({
      ...baseManifest(),
      contributes: { exporters: [{ id: 'raw', ext: '.pcm', label: { en: 'PCM' } }] },
    });
    expect(res.ok).to.equal(true);
    expect(res.value.contributes.exporters[0].mime).to.equal('');
  });
});

describe('PluginDataPlane — exportAudio', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-export-'));
    file = path.join(dir, 'song.flac');
    authorizePath(file);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makePlane(options = {}) {
    const calls = [];
    const registry = {
      list: (type) => (type === 'exporter' ? [exporterEntry] : []),
      getPlugin: (id) => (options.plugins || { p1: plugin('p1') })[id] || null,
    };
    const plane = new PluginDataPlane({
      registry,
      call: options.call || (async (pluginId, method, params) => {
        calls.push({ pluginId, method, params });
        return { bytes: new Uint8Array([1, 2, 3, 4]) };
      }),
    });
    return { plane, calls };
  }

  const audio = { interleaved: new Float32Array([0.1, -0.1, 0.2, -0.2]), channels: 2, sampleRate: 48000, durationSec: 0.001 };

  it('正常路径：把采样交给 exporter.export 并写盘', async () => {
    const { plane, calls } = makePlane();
    const res = await plane.exportAudio(file, { pluginId: 'p1', id: 'flac' }, audio);
    expect(res.ok).to.equal(true);
    expect(res.bytes).to.equal(4);
    expect(calls[0].method).to.equal('exporter.export');
    expect(calls[0].params.audio.frames).to.equal(2);
    expect(calls[0].params.audio.channels).to.equal(2);
    expect(calls[0].params.exporterId).to.equal('flac');
    expect(fs.readFileSync(file)).to.deep.equal(Buffer.from([1, 2, 3, 4]));
  });

  it('导出器不存在 → NOT_HANDLED', async () => {
    const { plane } = makePlane();
    const res = await plane.exportAudio(file, { pluginId: 'p1', id: 'nope' }, audio);
    expect(res.ok).to.equal(false);
    expect(res.code).to.equal(FILE_ERR.NOT_HANDLED);
  });

  it('插件被停用 → NOT_HANDLED（停用不能只是 UI 上的话）', async () => {
    const { plane } = makePlane({ plugins: { p1: { ...plugin('p1'), status: 'disabled' } } });
    const res = await plane.exportAudio(file, { pluginId: 'p1', id: 'flac' }, audio);
    expect(res.ok).to.equal(false);
    expect(res.code).to.equal(FILE_ERR.NOT_HANDLED);
  });

  it('目标扩展名与导出器声明不符 → 拒绝，且不调用插件', async () => {
    const wrong = path.join(dir, 'song.exe');
    authorizePath(wrong);
    const { plane, calls } = makePlane();
    const res = await plane.exportAudio(wrong, { pluginId: 'p1', id: 'flac' }, audio);
    expect(res.ok).to.equal(false);
    expect(res.code).to.equal('INVALID_REQUEST');
    expect(calls).to.have.length(0);
    expect(fs.existsSync(wrong)).to.equal(false);
  });

  it('缺 fs:userPicked:write → PERMISSION_DENIED', async () => {
    const { plane } = makePlane({ plugins: { p1: plugin('p1', { fs: [] }) } });
    const res = await plane.exportAudio(file, { pluginId: 'p1', id: 'flac' }, audio);
    expect(res.ok).to.equal(false);
    expect(res.code).to.equal('PERMISSION_DENIED');
  });

  it('未授权路径 → PERMISSION_DENIED', async () => {
    const other = path.join(os.tmpdir(), `sxs-unauth-${Date.now()}.flac`);
    const { plane } = makePlane();
    const res = await plane.exportAudio(other, { pluginId: 'p1', id: 'flac' }, audio);
    expect(res.ok).to.equal(false);
    expect(res.code).to.equal('PERMISSION_DENIED');
  });

  it('音频形状不对（非 Float32Array / 通道不整除 / 采样率离谱）→ INVALID_REQUEST', async () => {
    const { plane, calls } = makePlane();
    const bad = [
      null,
      { interleaved: [0.1, 0.2], channels: 1, sampleRate: 48000 },
      { interleaved: new Float32Array([1, 2, 3]), channels: 2, sampleRate: 48000 },
      { interleaved: new Float32Array(0), channels: 1, sampleRate: 48000 },
      { interleaved: new Float32Array([1, 2]), channels: 1, sampleRate: 100 },
    ];
    for (const a of bad) {
      const res = await plane.exportAudio(file, { pluginId: 'p1', id: 'flac' }, a);
      expect(res.ok, JSON.stringify(a)).to.equal(false);
    }
    expect(calls).to.have.length(0);
  });

  it('插件返回不可写入的东西 → INVALID_OUTPUT，原文件不动', async () => {
    const { plane } = makePlane({ call: async () => ({ bytes: { nope: true } }) });
    const res = await plane.exportAudio(file, { pluginId: 'p1', id: 'flac' }, audio);
    expect(res.ok).to.equal(false);
    expect(res.code).to.equal(FILE_ERR.INVALID_OUTPUT);
    expect(fs.existsSync(file)).to.equal(false);
  });

  it('插件报错 → 原样透传 message（插件负责本地化）', async () => {
    const { plane } = makePlane({ call: async () => { throw Object.assign(new Error('编码器崩溃'), { code: 'INTERNAL' }); } });
    const res = await plane.exportAudio(file, { pluginId: 'p1', id: 'flac' }, audio);
    expect(res.ok).to.equal(false);
    expect(res.message).to.equal('编码器崩溃');
  });

  it('插件取消 → CANCELLED，不写文件', async () => {
    const { plane } = makePlane({ call: async () => ({ cancelled: true }) });
    const res = await plane.exportAudio(file, { pluginId: 'p1', id: 'flac' }, audio);
    expect(res.ok).to.equal(false);
    expect(res.code).to.equal(FILE_ERR.CANCELLED);
    expect(fs.existsSync(file)).to.equal(false);
  });

  it('warnings 过滤成字符串数组', async () => {
    const { plane } = makePlane({ call: async () => ({ bytes: 'x', warnings: ['a', 3, '', null, 'b'] }) });
    const res = await plane.exportAudio(file, { pluginId: 'p1', id: 'flac' }, audio);
    expect(res.ok).to.equal(true);
    expect(res.warnings).to.deep.equal(['a', 'b']);
  });

  it('全小写扩展名：.FLAC 也能匹配', async () => {
    const upper = path.join(dir, 'Song.FLAC');
    authorizePath(upper);
    const { plane } = makePlane();
    const res = await plane.exportAudio(upper, { pluginId: 'p1', id: 'flac' }, audio);
    expect(res.ok).to.equal(true);
  });
});

describe('PluginDataPlane — listExporters', () => {
  it('按 ext 去重，后来的标 shadowed', () => {
    const registry = {
      list: (type) => (type === 'exporter' ? [
        exporterEntry,
        { ...exporterEntry, pluginId: 'p2', id: 'flac2' },
      ] : []),
      getPlugin: (id) => ({ p1: plugin('p1'), p2: plugin('p2') })[id] || null,
    };
    const plane = new PluginDataPlane({ registry, call: async () => ({}) });
    const list = plane.listExporters();
    expect(list).to.have.length(1);
    expect(list[0].pluginId).to.equal('p1');
    expect(list[0].shadowed.map((s) => s.pluginId)).to.deep.equal(['p2']);
  });

  it('停用的插件不出现在清单里', () => {
    const registry = {
      list: (type) => (type === 'exporter' ? [exporterEntry] : []),
      getPlugin: () => ({ ...plugin('p1'), status: 'disabled' }),
    };
    const plane = new PluginDataPlane({ registry, call: async () => ({}) });
    expect(plane.listExporters()).to.deep.equal([]);
  });
});
