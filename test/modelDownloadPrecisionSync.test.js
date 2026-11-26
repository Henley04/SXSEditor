/**
 * Regression tests for issue #44.
 *
 * The model-download dialog used to keep its precision choice local to the
 * renderer: files were downloaded into <modelDir>/<precision>/ while
 * settings.modelPrecision still pointed at the old precision. The startup
 * check and svs:init then looked at the wrong set and forced a multi-GB
 * re-download. These tests verify that every precision-aware download IPC
 * persists the selected precision before any model work begins, and that the
 * running sessions are reset so a live app switches precision as well.
 */
const { expect } = require('chai');
const Module = require('module');
const { IPC_CHANNELS } = require('../src/shared/ipcChannels');

async function makeHarness({ initialPrecision = 'fp32', saveResult = { success: true } } = {}) {
  const handlers = new Map();
  const state = {
    settings: { modelPrecision: initialPrecision },
    saves: [],
    checkCalls: [],
    resets: 0,
    saveResult,
  };

  const electronStub = {
    app: { isPackaged: false, getPath: () => '/tmp/sxseditor-test' },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {} },
  };
  const settingsStub = {
    loadSettings: () => ({ ...state.settings }),
    saveSettingsFile: async (settings) => {
      state.saves.push({ ...settings });
      if (saveResult.success) state.settings = { ...settings };
      return saveResult;
    },
  };
  const modelManagerStub = {
    DEFAULT_PRECISION: 'fp32',
    MODEL_IDS: {},
    JP_MODEL_IDS: { fp16: 'jp-fp16', fp32: 'jp-fp32' },
    JP_MODEL_FILE_MANIFEST: [],
    isPrecisionDownloadable: () => true,
    checkMissingFiles: (dir, precision) => {
      state.checkCalls.push({ dir, precision });
      return { missing: [], existing: [] };
    },
    checkMissingJpFiles: () => ({ missing: [], existing: [] }),
    getJpLocalFilePath: () => null,
    getJpFileDownloadUrl: () => null,
    getModelVersionPath: () => '/tmp/sxseditor-test/version.json',
    getJpModelVersionPath: () => '/tmp/sxseditor-test/jp-version.json',
    deleteModelFiles: () => {},
    invalidateJpModelsCache: () => {},
    saveModelVersion: () => {},
    saveJpModelVersion: () => {},
    getModelTags: async () => ['v4'],
    getJpModelTags: async () => ['v4'],
    getLatestTag: (tags) => tags[0],
  };
  const modelDirStub = {
    getModelDir: () => '/tmp/sxseditor-test/onnx_models',
    setCustomModelDir: () => {},
  };
  const svsIpcStub = {
    resetSvsPipeline: () => { state.resets += 1; },
  };
  const pitchIpcStub = {
    resetRmvpe: () => { state.resets += 1; },
    resetBasicPitch: () => { state.resets += 1; },
    resetRosvot: () => { state.resets += 1; },
  };
  const ipcSafeStub = {
    safeHandle: (channel, handler) => { handlers.set(channel, handler); },
  };

  const originalLoad = Module._load;
  const mocks = {
    electron: electronStub,
    './settings': settingsStub,
    './ipcSafe': ipcSafeStub,
    '../modelManager': modelManagerStub,
    './modelDir': modelDirStub,
    './svsIpc': svsIpcStub,
    './pitchMidiIpc': pitchIpcStub,
    './security': { isPathAllowed: () => true, isSystemPath: () => false },
    './locale': { t: (key) => key },
    './docs': { ONLINE_DOCS_BASE_URL: 'https://docs.example.test' },
    './windowManager': {
      createModelDownloadWindow: () => {},
      getModelDownloadWindow: () => null,
      getMainWindow: () => null,
    },
  };
  const patchedLoad = function (request) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.apply(this, arguments);
  };

  async function withMock(fn) {
    Module._load = patchedLoad;
    try {
      return await fn();
    } finally {
      Module._load = originalLoad;
    }
  }

  // Fresh module instance so registerModelDownloadIpc() registers into this harness's map.
  const target = require.resolve('../src/main/modelDownload');
  await withMock(async () => {
    delete require.cache[target];
    const mod = require(target);
    mod.registerModelDownloadIpc();
  });

  const invoke = (channel, args) => withMock(async () => {
    const fn = handlers.get(channel);
    if (typeof fn !== 'function') throw new Error(`Handler not registered: ${channel}`);
    return fn({}, ...args);
  });

  return { state, invoke };
}

const PRECISION_DOWNLOAD_CHANNELS = [
  ['MODEL_DOWNLOAD_START', IPC_CHANNELS.MODEL_DOWNLOAD_START],
  ['MODEL_DOWNLOAD_UPDATE', IPC_CHANNELS.MODEL_DOWNLOAD_UPDATE],
  ['MODEL_DOWNLOAD_START_JP', IPC_CHANNELS.MODEL_DOWNLOAD_START_JP],
  ['MODEL_DOWNLOAD_UPDATE_JP', IPC_CHANNELS.MODEL_DOWNLOAD_UPDATE_JP],
];

describe('modelDownload precision persistence (issue #44)', () => {
  for (const [label, channel] of PRECISION_DOWNLOAD_CHANNELS) {
    it(`${label} persists the dialog precision before model work`, async () => {
      const { state, invoke } = await makeHarness();

      await invoke(channel, ['fp16', 'v4']);

      expect(state.saves, `${label} must write settings`).to.have.length(1);
      expect(state.saves[0].modelPrecision).to.equal('fp16');
      // A live app must drop cached sessions so the new precision takes effect.
      expect(state.resets, `${label} must reset sessions`).to.be.at.least(1);
    });
  }

  it('commits precision before running the model file check', async () => {
    const { state, invoke } = await makeHarness();

    await invoke(IPC_CHANNELS.MODEL_DOWNLOAD_START, ['fp16', 'v4']);

    expect(state.checkCalls).to.have.length(1);
    expect(state.checkCalls[0].precision).to.equal('fp16');
    // Settings were written before the check — this is what stops the FP32 fallback.
    expect(state.saves).to.have.length(1);
  });

  it('writes a settings copy so a failed save cannot pollute the cache', async () => {
    const { state, invoke } = await makeHarness({
      saveResult: { success: false, error: 'EACCES' },
    });

    const result = await invoke(IPC_CHANNELS.MODEL_DOWNLOAD_START, ['fp16', 'v4']);

    expect(result.success).to.equal(false);
    expect(result.error).to.include('Failed to save model precision');
    // loadSettings() still returns the original precision — the in-memory
    // cache was never mutated with the rejected value.
    expect(state.settings.modelPrecision).to.equal('fp32');
    // No model work and no session reset should happen on a failed write.
    expect(state.checkCalls).to.have.length(0);
    expect(state.resets).to.equal(0);
  });

  it('does not rewrite settings or reset sessions when precision is unchanged', async () => {
    const { state, invoke } = await makeHarness({ initialPrecision: 'fp16' });

    await invoke(IPC_CHANNELS.MODEL_DOWNLOAD_START, ['fp16', 'v4']);

    expect(state.saves).to.have.length(0);
    expect(state.resets).to.equal(0);
  });
});
