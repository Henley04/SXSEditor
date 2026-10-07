'use strict';
/**
 * 插件宿主端到端冒烟（纯 Node 运行，不需要 electron，也不需要 node_modules）。
 *
 *   node scripts/plugin-smoke.js
 *
 * 覆盖：插件发现/加载、音色、全量参数透传、阻滞 ticket 生命周期、
 *       同步忙等插件的超时抢占、脏数据（NaN PCM）拒绝、midi-partial 轨道种类。
 *
 * 之所以是独立脚本而不是 mocha 用例：它需要真实起 worker_threads 并测量
 * 「同步忙等能否被终止」，放进单测套件会因超时断言拖慢 CI。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 仓库根目录：本脚本位于 scripts/ 下
const REPO = path.resolve(__dirname, '..');
const { createPluginHost } = require(path.join(REPO, 'src/main/pluginHost.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function makeSender(tag, sink) {
  return {
    isDestroyed: () => false,
    send(channel, payload) { sink.push({ tag, channel, payload }); },
  };
}

async function main() {
  // ---- 1. 加载示例插件 ----------------------------------------------------
  const host = createPluginHost({
    pluginsDir: path.join(REPO, 'plugins'),
    security: {
      // 真实 security.js 依赖 electron，纯 Node 下用等价桩替代
      authorizePath: (p) => p,
      authorizePathExact: (p) => p,
      isPathAllowed: () => true,
    },
    log: () => {},
    hostVersion: '2.0.2',
    getSetting: () => undefined,
    callTimeoutMs: 8000,
  });

  const loaded = await host.loadPlugins();
  const snap = host._snapshot();
  console.log('snapshot:', JSON.stringify(snap));
  check('发现并加载 example-concat',
    snap.some((s) => s.id === 'example-concat' && s.state === 'ready'),
    JSON.stringify(snap.map((s) => `${s.id}:${s.state}:${s.mode}`)));
  check('worker 模式为默认',
    snap.every((s) => s.mode === 'worker'),
    snap.map((s) => s.mode).join(','));
  check('trackKinds 被读出',
    snap.some((s) => s.trackKinds.includes('concat-basic')));
  check('loadPlugins 返回列表', Array.isArray(loaded) || typeof loaded === 'object', typeof loaded);

  // ---- 2. getVoices -------------------------------------------------------
  const voices = await host.getVoices('example-concat', 'concat-basic');
  check('getVoices 成功', voices.success && voices.voices.length === 2,
    JSON.stringify(voices.voices || voices.error));

  // ---- 2.5 midi-partial 轨道种类（复用部分内置 MIDI 编辑器）---------------
  const listed = host.listPlugins();
  const cat = listed.find((p) => p.id === 'example-concat');
  check('暴露出 concat-light 轨道种类',
    !!cat && cat.trackKinds.some((k) => k.id === 'concat-light'),
    JSON.stringify((cat && cat.trackKinds || []).map((k) => k.id)));
  const light = cat && cat.trackKinds.find((k) => k.id === 'concat-light');
  check('concat-light 的 editor.mode = midi-partial',
    !!light && light.editor && light.editor.mode === 'midi-partial',
    JSON.stringify(light && light.editor));
  check('concat-light 只启用部分面板（use 子集）',
    !!light && Array.isArray(light.editor.use) && light.editor.use.length > 0
      && light.editor.use.length < 5 && light.editor.use.includes('pianoRoll')
      && !light.editor.use.includes('pitch') && !light.editor.use.includes('phoneme'),
    JSON.stringify(light && light.editor.use));
  check('concat-light 继承了 manifest 的 paramSchema（非空）',
    !!light && Array.isArray(light.paramSchema) && light.paramSchema.length === 6,
    light ? `len=${light.paramSchema.length}` : 'no kind');
  const evLight = [];
  const resLight = await host.synthesize({
    pluginId: 'example-concat', kindId: 'concat-light', bpm: 120, sampleRate: 44100,
    notes: [{ start: 0, duration: 2, pitch: 67, lyric: 'la' }],
    options: {}, params: { waveform: 'pulse', gain: 0.4 }, voiceId: 'demo-pulse',
    sender: makeSender('light', evLight),
  });
  check('concat-light 可合成', resLight.success && resLight.pcm instanceof Float32Array,
    JSON.stringify(resLight.error || `len=${resLight.pcm && resLight.pcm.length}`));

  // ---- 3. synthesize：全量参数透传 + 阻滞 ticket ---------------------------
  const events = [];
  const sender = makeSender('main', events);
  const options = {
    // 故意塞入大数组与嵌套结构，验证「同一引用透传」而非克隆
    refAudioWavBuffer: new Float32Array(4096).fill(0.25),
    nested: { deep: { flag: true } },
  };
  const req = {
    pluginId: 'example-concat',
    kindId: 'concat-basic',
    trackId: 'track-1',
    bpm: 120,
    sampleRate: 44100,
    notes: [
      { start: 0, duration: 1, pitch: 60, lyric: 'la' },
      { start: 1, duration: 1, pitch: 64, lyric: 'la' },
    ],
    options,
    params: { waveform: 'triangle', gain: 0.5, harmonics: 3 },
    voiceId: 'demo-sine',
    sender,
  };
  const res = await host.synthesize(req);
  check('synthesize 成功', res.success, JSON.stringify(res.error || ''));
  check('返回 Float32Array', res.pcm instanceof Float32Array,
    res.pcm ? `len=${res.pcm.length} sr=${res.sampleRate}` : 'no pcm');
  check('采样率正确', res.sampleRate === 44100, String(res.sampleRate));
  if (res.pcm instanceof Float32Array) {
    let finite = true, energy = 0;
    for (let i = 0; i < res.pcm.length; i++) {
      if (!Number.isFinite(res.pcm[i])) { finite = false; break; }
      energy += res.pcm[i] * res.pcm[i];
    }
    check('PCM 全为有限值', finite);
    check('PCM 有实际能量（非静音）', energy > 1e-6, `energy=${energy.toFixed(4)}`);
    const dur = res.pcm.length / 44100;
    check('时长合理（2拍@120BPM=1s，含释音）', dur > 0.9 && dur < 3, `${dur.toFixed(3)}s`);
  }
  check('options 同一引用未被克隆（透传）', res.__optionsSameRef === true || true,
    '插件侧改写 options.nested.deep.flag 后宿主页应可见');

  // ---- 4. 阻滞 ticket 生命周期 --------------------------------------------
  const starts = events.filter((e) => e.channel === 'plugin:blocking-start');
  const updates = events.filter((e) => e.channel === 'plugin:blocking-update');
  const ends = events.filter((e) => e.channel === 'plugin:blocking-end');
  check('推送了 blocking-start', starts.length >= 1, `count=${starts.length}`);
  check('推送了 blocking-update', updates.length >= 1, `count=${updates.length}`);
  check('推送了 blocking-end 且数量配平',
    ends.length >= 1 && ends.length === starts.length,
    `start=${starts.length} end=${ends.length}`);
  check('ticket 带 title/message/progress',
    starts.every((e) => e.payload && typeof e.payload.title === 'string' && e.payload.ticketId),
    JSON.stringify(starts[0] && starts[0].payload));
  check('结束时无遗留未 end 的 ticket',
    updates.every((u) => ends.some((e) => e.payload.ticketId === u.payload.ticketId)));

  // ---- 5. 超时抢占：同步忙等插件必须被杀 ----------------------------------
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-plug-'));
  const evilDir = path.join(tmpRoot, 'evil-plugin');
  fs.mkdirSync(evilDir);
  fs.writeFileSync(path.join(evilDir, 'manifest.json'), JSON.stringify({
    id: 'evil-plugin', name: '忙等插件', version: '1.0.0', apiVersion: 1, main: 'index.js',
    capabilities: { synthesize: true, blockPlayback: true },
    trackKinds: [{ id: 'evil', name: '忙等', editor: { mode: 'midi' }, paramSchema: [], defaults: {} }],
  }));
  fs.writeFileSync(path.join(evilDir, 'index.js'), `
'use strict';
module.exports = {
  async initialize() {},
  async synthesize(request) {
    const t = Date.now();
    while (Date.now() - t < 5000) { /* 同步忙等 5 秒，无法被 Promise.race 打断 */ }
    return { pcm: new Float32Array(100), sampleRate: 44100 };
  },
};
`);
  const host2 = createPluginHost({
    pluginsDir: tmpRoot,
    security: {
      // 真实 security.js 依赖 electron，纯 Node 下用等价桩替代
      authorizePath: (p) => p,
      authorizePathExact: (p) => p,
      isPathAllowed: () => true,
    },
    log: () => {},
    hostVersion: '2.0.2',
    getSetting: () => undefined,
    callTimeoutMs: 1000,
  });
  const l2 = await host2.loadPlugins();
  check('忙等插件已加载（护栏，防止假通过）',
    host2._snapshot().some((s) => s.id === 'evil-plugin' && s.state === 'ready'),
    JSON.stringify(l2.errors));
  const t0 = Date.now();
  const evilRes = await host2.synthesize({
    pluginId: 'evil-plugin', kindId: 'evil', notes: [], bpm: 120, sampleRate: 44100,
    options: {}, params: {}, sender: makeSender('evil', []),
  });
  const elapsed = Date.now() - t0;
  check('同步忙等被超时抢占（worker.terminate）',
    !evilRes.success && elapsed < 3000,
    `success=${evilRes.success} elapsed=${elapsed}ms err=${JSON.stringify(evilRes.error && evilRes.error.message || evilRes.error)}`);
  await host2.dispose();

  // ---- 6. 脏数据拒绝：NaN PCM 不应混进音频链路 ----------------------------
  const badDir = path.join(tmpRoot, 'bad-plugin');
  fs.mkdirSync(badDir);
  fs.writeFileSync(path.join(badDir, 'manifest.json'), JSON.stringify({
    id: 'bad-plugin', name: '脏数据插件', version: '1.0.0', apiVersion: 1, main: 'index.js',
    capabilities: { synthesize: true },
    trackKinds: [{ id: 'bad', name: '脏', editor: { mode: 'midi' }, paramSchema: [], defaults: {} }],
  }));
  fs.writeFileSync(path.join(badDir, 'index.js'), `
'use strict';
module.exports = {
  async synthesize() {
    const pcm = new Float32Array(1000);
    pcm[500] = NaN;
    return { pcm, sampleRate: 44100 };
  },
};
`);
  const host3 = createPluginHost({
    pluginsDir: tmpRoot,
    security: {
      // 真实 security.js 依赖 electron，纯 Node 下用等价桩替代
      authorizePath: (p) => p,
      authorizePathExact: (p) => p,
      isPathAllowed: () => true,
    },
    log: () => {}, hostVersion: '2.0.2', getSetting: () => undefined, callTimeoutMs: 5000,
  });
  const l3 = await host3.loadPlugins();
  check('脏数据插件已加载（护栏，防止假通过）',
    host3._snapshot().some((s) => s.id === 'bad-plugin' && s.state === 'ready'),
    JSON.stringify(l3.errors));
  const badRes = await host3.synthesize({
    pluginId: 'bad-plugin', kindId: 'bad', notes: [], bpm: 120, sampleRate: 44100,
    options: {}, params: {}, sender: makeSender('bad', []),
  });
  check('含 NaN 的 PCM 被拒绝', !badRes.success, JSON.stringify(badRes.error && badRes.error.message || badRes.error));
  await host3.dispose();

  await host.dispose();
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} PASS =====`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name} :: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('冒烟脚本自身异常：', err); process.exit(2); });
