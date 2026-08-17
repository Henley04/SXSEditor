const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

function findWorkerScript() {
  const candidates = [
    path.join(__dirname, '..', 'inference', 'svsWorker.js'),
    path.join(__dirname, 'inference', 'svsWorker.js'),
  ];
  return candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
}

class SvsWorkerClient {
  constructor(workerData) {
    this.workerData = workerData;
    this.worker = null;
    this.readyPromise = null;
    this.nextId = 0;
    this.pending = new Map();
    this.initialized = false;
    this.sessionEPs = {};
    this.loadedModels = new Set();
    this.hardwareInfo = null;
  }

  _applyState(state) {
    if (!state) return;
    this.initialized = !!state.initialized;
    this.sessionEPs = state.sessionEPs || {};
    this.loadedModels = new Set(state.loadedModels || []);
    this.hardwareInfo = state.hardwareInfo || null;
  }

  async _ensureWorker() {
    if (this.worker && this.readyPromise) { await this.readyPromise; return; }
    const script = findWorkerScript();
    if (!script) throw new Error('svsWorker.js not found');
    let readyResolve, readyReject;
    this.readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const worker = new Worker(script, { workerData: this.workerData });
    this.worker = worker;
    worker.on('message', msg => {
      if (msg.type === 'ready') { readyResolve(); return; }
      const pending = this.pending.get(msg.id);
      if (msg.type === 'event') {
        if (msg.event === 'progress') pending?.onProgress?.(msg.data);
        if (msg.event === 'chunk-audio') pending?.onChunkAudio?.(msg.data);
        return;
      }
      if (!pending) return;
      this.pending.delete(msg.id);
      this._applyState(msg.state);
      if (msg.type === 'result') pending.resolve(msg.result);
      else {
        const err = new Error(msg.error?.message || 'SVS worker failed');
        if (msg.error?.code) err.code = msg.error.code;
        if (msg.error?.stack) err.stack = msg.error.stack;
        pending.reject(err);
      }
    });
    const fail = err => {
      readyReject(err);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.worker = null;
      this.readyPromise = null;
      this.initialized = false;
    };
    worker.once('error', fail);
    worker.once('exit', code => { if (code !== 0) fail(new Error(`SVS worker exited with code ${code}`)); });
    await this.readyPromise;
  }

  async _call(command, args = {}, callbacks = {}) {
    await this._ensureWorker();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...callbacks });
      this.worker.postMessage({ id, command, args });
    });
  }

  init(language) { return this._call('init', { language }); }
  synthesize(notes, bpm, options = {}) {
    const { onProgress, onChunkAudio, refF0Extractor, ...serializable } = options;
    return this._call('synthesize', { notes, bpm, language: options.language, options: {
      ...serializable, __progress: !!onProgress, __chunkAudio: !!onChunkAudio,
    } }, { onProgress, onChunkAudio });
  }
  synthesizeMultiStreaming(fragments, bpm, options = {}) {
    const { onProgress, onChunkAudio, ...serializable } = options;
    const cleanFragments = (fragments || []).map(f => ({
      ...f, options: f.options ? Object.fromEntries(Object.entries(f.options).filter(([, v]) => typeof v !== 'function')) : f.options,
    }));
    return this._call('synthesizeMultiStreaming', { fragments: cleanFragments, bpm, language: options.language, options: {
      ...serializable, __progress: !!onProgress, __chunkAudio: !!onChunkAudio,
    } }, { onProgress, onChunkAudio });
  }
  resolveLyricToPhonemes(lyric) { return this._call('resolvePhonemes', { lyrics: [lyric] }).then(r => r[0]); }
  resolvePhonemes(lyrics, language) { return this._call('resolvePhonemes', { lyrics, language }); }
  swapLanguageModels(language) { return this._call('swapLanguageModels', { language }); }
  swapVocoder(value) { return this._call('swapVocoder', { value }); }
  swapSifiganPrecision(value) { return this._call('swapSifiganPrecision', { value }); }
  loadModel(key) { return this._call('loadModel', { key }); }
  unloadModel(key) { this.loadedModels.delete(key); return this._call('unloadModel', { key }); }
  ensureAllModelsLoaded() { return this._call('ensureAllModelsLoaded'); }
  clearSynthCache() { return this._call('clearSynthCache'); }
  isModelLoaded(key) { return this.loadedModels.has(key); }
  getHardwareInfo() { return this.hardwareInfo; }
  async cancelActiveSynthesis() {
    if (!this.worker) return;
    const err = new Error('Synthesis cancelled');
    err.code = 'SYNTHESIS_CANCELLED';
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    this.initialized = false;
    try { await worker.terminate(); } catch (_) {}
  }

  async dispose() {
    if (!this.worker) return;
    try { await this._call('dispose'); } catch (_) {}
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    this.initialized = false;
    try { await worker.terminate(); } catch (_) {}
  }
}

module.exports = { SvsWorkerClient, findWorkerScript };
