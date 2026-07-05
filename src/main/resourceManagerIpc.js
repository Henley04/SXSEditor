const { ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { getModelGroups } = require('../modelRegistry');
const { getModelDir } = require('./modelDir');
const { ensureGPUInfo, queryGPUVRAMUsage, detectNPUCached, getGPUPhase } = require('./gpuInfo');
const { enumerateDMLDevices } = require('../inference/pipeline');
const { getSvsPipeline } = require('./svsIpc');
const { getRmvpeDetector, getBasicPitchDetector, getRosvotDetector, rmvpeLazy, basicPitchLazy, rosvotLazy } = require('./pitchMidiIpc');
const { openResourceManagerWindow } = require('./windowManager');
const { getCachedDMLDevices, setCachedDMLDevices } = require('./settingsIpc');

// #9: 缓存文件检查结果
let modelFilesCache = null;
let modelFilesCacheDir = null;

function invalidateModelFilesCache() {
  modelFilesCache = null;
  modelFilesCacheDir = null;
}

// int8-npu 模型已将外部数据自包含到 .onnx 文件中，无需检查 .onnx.data 文件
const PRECISION_NO_EXTERNAL_DATA = new Set(['int8-npu']);

async function getModelFilesInfo() {
  const modelDir = getModelDir();
  if (modelFilesCache && modelFilesCacheDir === modelDir) {
    return modelFilesCache;
  }

  const { loadSettings } = require('./settings');
  const currentPrecision = loadSettings().modelPrecision || 'fp16';
  const skipExternalData = PRECISION_NO_EXTERNAL_DATA.has(currentPrecision);

  const groups = getModelGroups();
  const cache = {};

  for (const group of groups) {
    for (const model of group.models) {
      let totalFileSize = 0;
      let filesExist = true;
      for (const file of model.files) {
        // int8-npu 模型跳过 .onnx.data 文件检查
        if (skipExternalData && file.endsWith('.onnx.data')) continue;
        const fullPath = path.join(modelDir, file);
        try {
          const stats = await fs.promises.stat(fullPath);
          totalFileSize += stats.size;
        } catch (_) {
          filesExist = false;
        }
      }
      cache[`${group.id}/${model.id}`] = { fileSize: totalFileSize, filesExist };
    }
  }

  modelFilesCache = cache;
  modelFilesCacheDir = modelDir;
  return cache;
}

// #6: 抽取公共的模型加载/卸载辅助函数
async function loadSingleModel(groupId, modelId) {
  if (groupId === 'svs') {
    const pipeline = getSvsPipeline();
    if (!pipeline || !pipeline.initialized) {
      const { svsPipelineLazy } = require('./svsIpc');
      await svsPipelineLazy.get();
    }
    const p = getSvsPipeline();
    const modelDef = getModelGroups().find(g => g.id === 'svs')?.models.find(m => m.id === modelId);
    if (!modelDef) return { success: false, error: 'Model not found in registry' };
    return p.loadModel(modelDef.sessionKey);
  } else if (groupId === 'rmvpe') {
    await rmvpeLazy.get();
    return { success: true };
  } else if (groupId === 'basicPitch') {
    await basicPitchLazy.get();
    return { success: true };
  } else if (groupId === 'rosvot') {
    await rosvotLazy.get();
    return { success: true };
  }
  return { success: false, error: `Unknown group: ${groupId}` };
}

async function unloadSingleModel(groupId, modelId) {
  if (groupId === 'svs') {
    const pipeline = getSvsPipeline();
    if (!pipeline || !pipeline.initialized) {
      return { success: false, error: 'SVS Pipeline not initialized' };
    }
    const modelDef = getModelGroups().find(g => g.id === 'svs')?.models.find(m => m.id === modelId);
    if (!modelDef) return { success: false, error: 'Model not found in registry' };
    return pipeline.unloadModel(modelDef.sessionKey);
  } else if (groupId === 'rmvpe') {
    const d = getRmvpeDetector();
    if (d) { try { d.dispose(); } catch (_) {} }
    rmvpeLazy.reset();
    return { success: true };
  } else if (groupId === 'basicPitch') {
    const d = getBasicPitchDetector();
    if (d) { try { d.dispose(); } catch (_) {} }
    basicPitchLazy.reset();
    return { success: true };
  } else if (groupId === 'rosvot') {
    const d = getRosvotDetector();
    if (d) { try { d.dispose(); } catch (_) {} }
    rosvotLazy.reset();
    return { success: true };
  }
  return { success: false, error: `Unknown group: ${groupId}` };
}

function cleanupOnLoadFailure(groupId) {
  if (groupId === 'rmvpe') { const d = getRmvpeDetector(); if (d) { try { d.dispose(); } catch (_) {} } rmvpeLazy.reset(); }
  if (groupId === 'basicPitch') { const d = getBasicPitchDetector(); if (d) { try { d.dispose(); } catch (_) {} } basicPitchLazy.reset(); }
  if (groupId === 'rosvot') { const d = getRosvotDetector(); if (d) { try { d.dispose(); } catch (_) {} } rosvotLazy.reset(); }
}

function registerResourceManagerIpc() {
  ipcMain.handle('resmgr:open', async () => {
    openResourceManagerWindow();
    return { success: true };
  });

  ipcMain.handle('resmgr:getGPUInfo', async () => {
    try {
      // 并行获取 VRAM、GPU 控制器和 NPU 状态
      const [vramData, controllers, npuResult] = await Promise.all([
        queryGPUVRAMUsage(),
        ensureGPUInfo(),
        detectNPUCached(),
      ]);

      let devices = getCachedDMLDevices();
      if (!devices) {
        devices = await enumerateDMLDevices(getModelDir(), controllers);
        setCachedDMLDevices(devices);
      }

      // Add NPU device if available via WebNN
      if (npuResult.npuAvailable && !devices.some(d => d.deviceType === 'npu')) {
        devices = [...devices, {
          name: 'NPU (WebNN)',
          deviceType: 'npu',
          isDiscrete: false,
          vramBytes: 0,
          vram: '0 MB',
          vendor: '',
          dxgiAdapterNumber: undefined,
          source: 'webnn',
        }];
      }

      const gpuList = devices.map(d => {
        const vramInfo = vramData.find(v => v.adapterIndex === d.dxgiAdapterNumber);
        const usageBytes = vramInfo ? vramInfo.usageBytes : 0;
        const budgetBytes = vramInfo ? vramInfo.budgetBytes : 0;
        return {
          name: d.name,
          deviceType: d.deviceType || (d.isDiscrete ? 'discrete-gpu' : 'integrated-gpu'),
          isDiscrete: d.isDiscrete,
          vram: d.vram,
          vramBytes: d.vramBytes,
          vendor: d.vendor,
          dxgiAdapterNumber: d.dxgiAdapterNumber,
          currentUsageBytes: usageBytes,
          budgetBytes: budgetBytes > 0 ? budgetBytes : d.vramBytes,
        };
      });

      return { success: true, gpus: gpuList };
    } catch (err) {
      console.error('[Main] Failed to get GPU info:', err);
      return { success: false, gpus: [], error: err.message };
    }
  });

  ipcMain.handle('resmgr:getModelGroups', async () => {
    const groups = getModelGroups();
    const filesInfo = await getModelFilesInfo();

    const result = [];
    for (const group of groups) {
      if (group.disabled) continue;

      const groupResult = {
        id: group.id,
        name: group.name,
        nameEn: group.nameEn,
        description: group.description,
        descriptionEn: group.descriptionEn,
        required: group.required,
        pipelineRef: group.pipelineRef,
        models: [],
      };

      for (const model of group.models) {
        const cacheKey = `${group.id}/${model.id}`;
        const { fileSize, filesExist } = filesInfo[cacheKey] || { fileSize: 0, filesExist: false };

        let loaded = false;
        let ep = null;

        const pipeline = getSvsPipeline();
        if (group.id === 'svs' && pipeline && pipeline.initialized) {
          loaded = pipeline.isModelLoaded(model.sessionKey);
          ep = pipeline.sessionEPs[model.sessionKey] || null;
        } else if (group.id === 'rmvpe') {
          const d = getRmvpeDetector();
          loaded = !!(d && d.initialized);
          ep = d ? (d.usingDML ? 'dml' : 'cpu') : null;
        } else if (group.id === 'basicPitch') {
          const d = getBasicPitchDetector();
          loaded = !!(d && d.initialized);
          ep = 'tfjs';
        } else if (group.id === 'rosvot') {
          const d = getRosvotDetector();
          loaded = !!(d && d.initialized);
          ep = d ? (d.usingDML ? 'dml' : 'cpu') : null;
        }

        groupResult.models.push({
          id: model.id,
          name: model.name,
          nameEn: model.nameEn,
          description: model.description,
          descriptionEn: model.descriptionEn,
          sessionKey: model.sessionKey,
          files: model.files,
          fileSize,
          filesExist,
          loaded,
          ep,
        });
      }

      result.push(groupResult);
    }

    return { success: true, groups: result };
  });

  ipcMain.handle('resmgr:loadModel', async (event, { groupId, modelId }) => {
    try {
      return await loadSingleModel(groupId, modelId);
    } catch (err) {
      console.error(`[Main] Failed to load model (${groupId}/${modelId}):`, err.message);
      cleanupOnLoadFailure(groupId);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('resmgr:unloadModel', async (event, { groupId, modelId }) => {
    try {
      return await unloadSingleModel(groupId, modelId);
    } catch (err) {
      console.error(`[Main] Failed to unload model (${groupId}/${modelId}):`, err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('resmgr:loadGroup', async (event, { groupId }) => {
    try {
      if (groupId === 'svs') {
        const pipeline = getSvsPipeline();
        if (!pipeline || !pipeline.initialized) {
          const { svsPipelineLazy } = require('./svsIpc');
          await svsPipelineLazy.get();
        }
        const p = getSvsPipeline();
        await p.ensureAllModelsLoaded();
        return { success: true };
      }
      const group = getModelGroups().find(g => g.id === groupId);
      if (!group) return { success: false, error: `Unknown group: ${groupId}` };
      for (const model of group.models) {
        await loadSingleModel(groupId, model.id);
      }
      return { success: true };
    } catch (err) {
      console.error(`[Main] Failed to load model group (${groupId}):`, err.message);
      cleanupOnLoadFailure(groupId);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('resmgr:unloadGroup', async (event, { groupId }) => {
    try {
      if (groupId === 'svs') {
        const pipeline = getSvsPipeline();
        if (pipeline && pipeline.initialized) {
          const group = getModelGroups().find(g => g.id === 'svs');
          if (group) {
            for (const model of group.models) {
              try { pipeline.unloadModel(model.sessionKey); } catch (_) {}
            }
          }
        }
        return { success: true };
      }
      const group = getModelGroups().find(g => g.id === groupId);
      if (!group) return { success: false, error: `Unknown group: ${groupId}` };
      for (const model of group.models) {
        await unloadSingleModel(groupId, model.id);
      }
      return { success: true };
    } catch (err) {
      console.error(`[Main] Failed to unload model group (${groupId}):`, err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerResourceManagerIpc,
  invalidateModelFilesCache,
  loadSingleModel,
  unloadSingleModel,
  cleanupOnLoadFailure,
};
