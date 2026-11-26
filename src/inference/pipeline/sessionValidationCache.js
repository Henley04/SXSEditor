/**
 * sessionValidationCache.js — 持久化 "dummy 推理校验已通过" 的结果。
 *
 * 背景：`createSessionWithValidation` 每创建一个 ONNX session 都要按模型签名
 * 构造 dummy 输入并跑一次真实推理，确认 EP 能执行该模型（DML 不支持某些算子、
 * WinML vendor EP 会静默产出全零等）。这一步在主进程 / svsWorker 启动时是
 * 串行的，模型多时带来可感知的初始化延迟。
 *
 * 判定依据（用户需求）：
 *   · **EP 组合**：同一模型在不同 EP（DML device / WinML vendor EP / CPU）上的
 *     校验结果互不通用；EP 变化必须重新校验。
 *   · **模型身份**：模型文件路径 + sessionKey + 静态/动态形状。精度切换会落在
 *     不同的模型目录，因此切到其它精度再切回来时仍能命中原来那条记录。
 *   · **模型版本**：读取模型同目录的 version.json（version / revision）以及文件
 *     的 size / mtime；任一变化都视为"换了模型"，必须重新校验。
 *
 * 存储位置：`<userData>/session-validation-cache.json`（应用数据目录），
 * 进程重启后仍然有效。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createJsonFileCache } = require('../persistentCache');

const MAX_EP_KEYS = 16;
const MAX_MODELS_PER_EP = 64;

const _store = createJsonFileCache('session-validation-cache.json', {
  format: 1,
  // 主进程与 svsWorker 可能各自校验了一部分模型：落盘前按 EP → 模型 key 浅合并，
  // 本地（本次进程）记录优先，保留磁盘上另一个进程写入的条目。
  merge: (diskData, localData) => {
    const merged = { ...diskData };
    for (const [epKey, models] of Object.entries(localData || {})) {
      merged[epKey] = { ...(diskData[epKey] || {}), ...(models || {}) };
    }
    return merged;
  },
});

// 模型目录 → { version, revision, versionFile, versionMtimeMs }
// version.json 可能被"同精度下重新下载模型"替换，因此每次 stat 版本文件，
// mtime 变化就重读，避免进程内缓存住旧版本号。
const _versionDirCache = new Map();

function configureCacheDir(dir) {
  _store.configureDir(dir);
}

function _readVersionInfo(dir) {
  const versionFile = path.join(dir, 'version.json');
  let mtimeMs = 0;
  try {
    mtimeMs = Math.round(fs.statSync(versionFile).mtimeMs);
  } catch (_) {
    mtimeMs = 0;
  }
  const cached = _versionDirCache.get(dir);
  if (cached && cached.versionFile === versionFile && cached.versionMtimeMs === mtimeMs) {
    return cached;
  }
  let version = null;
  let revision = null;
  if (mtimeMs > 0) {
    try {
      const parsed = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      if (typeof parsed.version === 'string') version = parsed.version;
      if (typeof parsed.revision === 'string') revision = parsed.revision;
    } catch (_) { /* 损坏的 version.json 当作"无版本号"，用文件指纹兜底 */ }
  }
  const info = { versionFile, versionMtimeMs: mtimeMs, version, revision };
  _versionDirCache.set(dir, info);
  return info;
}

/** 模型身份键：同一路径 + session 类型 + 形状模式。 */
function buildModelKey(modelPath, sessionKey, useStaticShapes) {
  const shapeMode = useStaticShapes === true ? 'static' : 'dynamic';
  return `${path.resolve(String(modelPath))}::${sessionKey}::${shapeMode}`;
}

/**
 * 组装 EP 维度键。
 *
 * @param {{provider:string, device?:string, runtime?:string|null}} q
 *   provider: EP 名（'dml' / 'NvTensorRTRTXExecutionProvider' / 'cpu'）
 *   device:   硬件身份。用 **GPU 名称**而不是 deviceId —— deviceId 只是
 *             枚举索引，换卡后仍是 0，会让新卡误命中旧卡的校验记录。
 *   runtime:  EP 运行时版本指纹（见 winmlProvider.getTrtRuntimeFingerprint）。
 *             只有 TRT 这类"每次启动重新编译 engine"的 EP 需要；其它 EP 传空，
 *             键里也不会多出空段，保证与旧记录格式一致。
 */
function buildValidationEpKey({ provider, device, runtime } = {}) {
  const p = String(provider || 'unknown');
  const d = String(device || 'auto');
  const r = runtime ? String(runtime) : '';
  return r ? `${p}@${d}@${r}` : `${p}@${d}`;
}

/**
 * 查询该 (EP, 模型) 是否已有成功的校验记录。
 * @param {{epKey:string, modelPath:string, sessionKey:string, useStaticShapes?:boolean}} q
 * @returns {Promise<object|null>} 命中时返回记录，否则 null
 */
async function getValidationRecord({ epKey, modelPath, sessionKey, useStaticShapes }) {
  if (!epKey || !modelPath || !sessionKey) return null;
  if (!_store.getDir()) return null;
  let stat;
  try {
    stat = await fs.promises.stat(modelPath);
  } catch (_) {
    return null;
  }
  const state = _store.load();
  const epEntries = state.data[epKey];
  if (!epEntries || typeof epEntries !== 'object') return null;
  const record = epEntries[buildModelKey(modelPath, sessionKey, useStaticShapes)];
  if (!record || typeof record !== 'object') return null;

  if (record.size !== stat.size || record.mtimeMs !== Math.round(stat.mtimeMs)) return null;

  const info = _readVersionInfo(path.dirname(modelPath));
  if ((record.modelVersion || null) !== (info.version || null)) return null;
  if ((record.modelRevision || null) !== (info.revision || null)) return null;

  return record;
}

/**
 * 记录一次成功的 dummy 推理校验。
 * @param {{epKey:string, modelPath:string, sessionKey:string, useStaticShapes?:boolean, detail?:string}} q
 * @returns {Promise<boolean>}
 */
async function recordValidation({ epKey, modelPath, sessionKey, useStaticShapes, detail }) {
  if (!epKey || !modelPath || !sessionKey) return false;
  if (!_store.getDir()) return false;
  let stat;
  try {
    stat = await fs.promises.stat(modelPath);
  } catch (_) {
    return false;
  }
  const info = _readVersionInfo(path.dirname(modelPath));
  const modelKey = buildModelKey(modelPath, sessionKey, useStaticShapes);
  const record = {
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    modelVersion: info.version || null,
    modelRevision: info.revision || null,
    validatedAt: Date.now(),
    detail: detail ? String(detail).slice(0, 120) : undefined,
  };

  _store.update((data) => {
    let epEntries = data[epKey];
    if (!epEntries || typeof epEntries !== 'object') {
      epEntries = {};
      data[epKey] = epEntries;
    }
    epEntries[modelKey] = record;

    // 每个 EP 只保留最近 N 个模型；EP 本身也做上限，避免长期使用后文件无限增长。
    const modelKeys = Object.keys(epEntries);
    if (modelKeys.length > MAX_MODELS_PER_EP) {
      modelKeys
        .sort((a, b) => (epEntries[a].validatedAt || 0) - (epEntries[b].validatedAt || 0))
        .slice(0, modelKeys.length - MAX_MODELS_PER_EP)
        .forEach((key) => { delete epEntries[key]; });
    }
    const epKeys = Object.keys(data);
    if (epKeys.length > MAX_EP_KEYS) {
      epKeys
        .sort((a, b) => {
          const newest = (key) => Object.values(data[key])
            .reduce((max, item) => Math.max(max, item.validatedAt || 0), 0);
          return newest(a) - newest(b);
        })
        .slice(0, epKeys.length - MAX_EP_KEYS)
        .forEach((key) => { delete data[key]; });
    }
    return true;
  });
  return true;
}

/** 等待挂起的落盘（退出前 / 测试用）。 */
function flush() {
  return _store.flush();
}

/** 同步落盘：before-quit 等退出路径用，避免 debounce 未触发就丢结果。 */
function flushSync() {
  return _store.flushSync();
}

/** 清空磁盘与内存缓存。 */
function clearValidationCache() {
  _versionDirCache.clear();
  return _store.clear();
}

/** 单测：重置内存状态并切换缓存目录（传 null 表示回到自动解析 userData）。 */
function _resetForTest(dir) {
  _versionDirCache.clear();
  _store.resetMemory();
  if (dir) _store.configureDir(dir);
  else _store.clearDirOverride();
}

module.exports = {
  configureCacheDir,
  buildModelKey,
  buildValidationEpKey,
  getValidationRecord,
  recordValidation,
  flush,
  flushSync,
  clearValidationCache,
  _resetForTest,
};
