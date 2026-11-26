/**
 * Regression tests for issue #44.
 *
 * The model-download dialog used to keep its precision choice local to the
 * renderer: files were downloaded into <modelDir>/<precision>/ while
 * settings.modelPrecision still pointed at the old precision. The startup
 * check and svs:init then looked at the wrong set and forced a multi-GB
 * re-download. These tests verify that MODEL_DOWNLOAD_START persists the
 * selected precision before any model work begins.
 */
const { expect } = require('chai');
const Module = require('module');
const path = require('node:path');
const { IPC_CHANNELS } = require('../src/shared/ipcChannels');

function makeHarness({ initialPrecision = 'fp32', saveResult = { success: true } } = {}) {
  const handlers = new Map();
  const state = {
    settings: { modelPrecision: initialPrecision },
    saves: [],
    checkCalls: [],
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
    isPrecisionDownloadable: () => true,
    checkMissingFiles: (dir, precision) => {
      state.checkCalls.push({ dir, precision });
      return { missing: [], existing: [] };
    },
    saveModelVersion: () => {},
    getModelTags: async () => ['v4'],
    getLatestTag: (tags) => tags[0],
  };
  const modelDirStub = {
    getModelDir: () => '/tmp/sxseditor-test/onnx_models',
    setCustomModelDir: () => {},
  };
  const ipcSafeStub = {
    safeHandle: (channel, handler) => { handlers.set(channel, handler); },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    const isTarget = parent && parent.filename
      && parent.filename.split(path.sep).slice(-3).join('/') === 'src/main/modelDownload.js';
    if (isTarget) {
      switch (request) {
        case 'electron': return electronStub;
        case './settings': return settingsStub;
        case './ipcSafe': return ipcSafeStub;
        case '../modelManager': return modelManagerStub;
        case './modelDir': return modelDirStub;
        case './security': return { isPathAllowed: () => true, isSystemPath: () => false };
        case './locale': return { t: (key) => key };
        case './docs': return { ONLINE_DOCS_BASE_URL: 'https://docs.example.test' };
        case './windowManager': return {
          createModelDownloadWindow: () => {},
          getModelDownloadWindow: () => null,
          getMainWindow: () => null,
        };
        default: break;
      }
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    // Each harness needs a fresh module instance so registerModelDownloadIpc()
    // re-registers handlers into this harness's map.
    const target = require.resolve('../src/main/modelDownload');
    delete require.cache[target];
    const mod = require(target);
    mod.registerModelDownloadIpc();
  } finally {
    Module._load = originalLoad;
  }

  return { state, handler: handlers.get(IPC_CHANNELS.MODEL_DOWNLOAD_START) };
}

describe('modelDownload precision persistence (issue #44)', () => {
  it('persists the precision chosen in the download dialog', async () => {
    const { state, handler } = makeHarness();
    expect(handler).to.be.a('function');

    const result = await handler({}, 'fp16', 'v4');

    expect(result).to.deep.equal({ success: true });
    expect(state.saves).to.have.length(1);
    expect(state.saves[0].modelPrecision).to.equal('fp16');
    // The model check must run against the very precision that was downloaded.
    expect(state.checkCalls[0].precision).to.equal('fp16');
  });

  it('does not rewrite settings when the precision is unchanged', async () => {
    const { state, handler } = makeHarness({ initialPrecision: 'fp16' });

    await handler({}, 'fp16', 'v4');

    expect(state.saves).to.have.length(0);
  });

  it('aborts the download when the precision cannot be persisted', async () => {
    const { state, handler } = makeHarness({
      saveResult: { success: false, error: 'EACCES' },
    });

    const result = await handler({}, 'fp16', 'v4');

    expect(result.success).to.equal(false);
    expect(result.error).to.include('Failed to save model precision');
    // No model work should start with an out-of-sync precision.
    expect(state.checkCalls).to.have.length(0);
  });
});
