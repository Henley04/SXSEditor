const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { URL } = require('node:url');

const MODEL_IDS = {
  fp32: 'syxppp/SoulX-Singer-onnx-directml',
  fp16: 'syxppp/SoulX-Singer-onnx-directml-fp16',
  int8: 'syxppp/SoulX-Singer-onnx-directml-int8',
  'int8-npu': 'syxppp/SoulX-Singer-onnx-directml-int8-dynamic',
  // SiFiGAN ONNX 模型仓库 (FP32 DML 兼容版 + stats)
  sifigan: 'syxppp/sifigan-onnx',
};

// JP (Japanese) language-specific model repos
// These contain only the modified models (note_text_encoder, preflow)
const JP_MODEL_IDS = {
  fp16: 'syxppp/SoulX-Singer-onnx-fp16-lora-jp',
};
const DEFAULT_PRECISION = 'fp16';
const MODELSCOPE_ENDPOINT = 'https://modelscope.cn';
const TEMP_SUFFIX = '.download';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ===== Model version management =====
// Model versions are determined solely by ModelScope tags (e.g. 'v0', 'v1').
// Downloads always use a specific tag — branch-based downloads ('master')
// are no longer supported. When a model is downloaded, a version.json file
// is written to the precision subdirectory recording the tag. If version.json
// is missing or records 'master' (legacy), an update is flagged as available.
const VERSION_FILE_NAME = 'version.json';

// 分片多线程下载相关常量
const MAX_GLOBAL_CONCURRENCY = 16;
const MIN_FILE_SIZE_FOR_CHUNKING = 16 * 1024 * 1024; // 16MB 以下不分片
const CHUNK_META_SUFFIX = '.download.meta';
const CHUNK_PART_SUFFIX = '.download.part';

const MODEL_FILE_MANIFEST = [
  { filePath: 'note_text_encoder.onnx', required: true },
  { filePath: 'note_text_encoder.onnx.data', required: true },
  { filePath: 'note_pitch_encoder.onnx', required: true },
  { filePath: 'note_pitch_encoder.onnx.data', required: true },
  { filePath: 'note_type_encoder.onnx', required: true },
  { filePath: 'note_type_encoder.onnx.data', required: true },
  { filePath: 'f0_encoder.onnx', required: true },
  { filePath: 'f0_encoder.onnx.data', required: true },
  { filePath: 'preflow.onnx', required: true },
  { filePath: 'preflow.onnx.data', required: true },
  { filePath: 'cond_emb.onnx', required: true },
  { filePath: 'cond_emb.onnx.data', required: true },
  { filePath: 'diff_step_dml.onnx', required: true },
  { filePath: 'vocoder_dml.onnx', required: true },
  { filePath: 'sifigan_vocoder_dml_fp16.onnx', required: false, size: 0.3 * 1024 * 1024, group: 'sifigan-vocoder' },
  { filePath: 'sifigan_vocoder_dml_fp16.onnx.data', required: false, size: 22.7 * 1024 * 1024, group: 'sifigan-vocoder' },
  { filePath: 'sifigan_vocoder_dml.onnx', required: false, size: 340 * 1024, group: 'sifigan-vocoder' },
  { filePath: 'sifigan_vocoder_dml.onnx.data', required: false, size: 47 * 1024 * 1024, group: 'sifigan-vocoder' },
  { filePath: 'sifigan_stats.joblib', required: false, size: 2.5 * 1024, group: 'sifigan-vocoder' },
  { filePath: 'mel_transform.onnx', required: true },
  { filePath: 'mel_transform.onnx.data', required: true },
  { filePath: 'preprocess/rmvpe_model.onnx', required: true },
  { filePath: 'preprocess/rmvpe_mel.onnx', required: false },
  { filePath: 'preprocess/rosvot_model.onnx', required: false },
  { filePath: 'basic_pitch_model/model.json', required: true },
  { filePath: 'basic_pitch_model/group1-shard1of1.bin', required: true },
];

// JP language models: fine-tuned files (note_text_encoder + preflow + cond_emb + diff_step_dml).
// All four are required for correct JP inference (v3+): cond_emb must match the
// JP fine-tuned preflow+embedding, and diff_step_dml must contain the merged
// DiffLlama LoRA weights for proper JP acoustic modeling.
const JP_MODEL_FILE_MANIFEST = [
  { filePath: 'note_text_encoder.onnx', required: true },
  { filePath: 'preflow.onnx', required: true },
  { filePath: 'cond_emb.onnx', required: true },
  // diff_step_dml.onnx: v3+ 日语微调对 22 层 DiffLlama attention 注入了 LoRA，
  // 合并后的 cfm_decoder 权重必须随 JP 模式切换才能让 DiffLlama LoRA 生效。
  // v1/v2 仅微调 preflow+cond_emb，此文件可选；v3+ 必需。
  { filePath: 'diff_step_dml.onnx', required: true },
  // note_pitch_encoder is intentionally NOT in this manifest: JP LoRA shares
  // the base model's pitch encoder (MIDI pitch is language-agnostic).
];

function getModelId(precision) {
  if (precision && precision in MODEL_IDS) return MODEL_IDS[precision];
  return MODEL_IDS[DEFAULT_PRECISION];
}

function isPrecisionDownloadable(precision) {
  const id = MODEL_IDS[precision];
  return id && id.length > 0;
}

function getJpModelId(precision) {
  return JP_MODEL_IDS[precision] || JP_MODEL_IDS[DEFAULT_PRECISION] || null;
}

const PRECISION_SUBDIR_PRECESIONS = new Set(['int8', 'fp16', 'int8-npu']);

const PRECISION_SUBDIR_MAP = {
  'int8': 'int8',
  'fp16': 'fp16',
  'int8-npu': path.join('int8', 'optimized_npu'),
};

// int8-npu 模型已将外部数据自包含到 .onnx 文件中，无需下载 .onnx.data 文件
const PRECISION_NO_EXTERNAL_DATA = new Set(['int8-npu']);

function getManifestForPrecision(precision) {
  if (PRECISION_NO_EXTERNAL_DATA.has(precision)) {
    return MODEL_FILE_MANIFEST.filter(f => !f.filePath.endsWith('.onnx.data'));
  }
  return MODEL_FILE_MANIFEST;
}

function isSvsModelFile(filePath) {
  return !filePath.startsWith('preprocess/') && !filePath.startsWith('basic_pitch_model/');
}

function getLocalFilePath(baseDir, filePath, precision) {
  if (precision && PRECISION_SUBDIR_PRECESIONS.has(precision) && isSvsModelFile(filePath)) {
    const subdir = PRECISION_SUBDIR_MAP[precision] || precision;
    return path.join(baseDir, subdir, filePath);
  }
  return path.join(baseDir, filePath);
}

/**
 * Get the local file path for a JP language model.
 * JP models are stored in a JP subdirectory under the precision directory.
 * e.g., onnx_models/fp16/JP/note_text_encoder.onnx
 */
function getJpLocalFilePath(baseDir, filePath, precision) {
  if (precision && PRECISION_SUBDIR_PRECESIONS.has(precision) && isSvsModelFile(filePath)) {
    const subdir = PRECISION_SUBDIR_MAP[precision] || precision;
    return path.join(baseDir, subdir, 'JP', filePath);
  }
  return path.join(baseDir, 'JP', filePath);
}

// 缓存 checkJpModelsExist 结果，避免每次日文合成时 4 次 fs.statSync 阻塞主线程。
// 通过 invalidateJpModelsCache() 在 JP 模型下载/删除后失效。
const _jpModelsExistCache = new Map(); // key: `${baseDir}|${precision}` → boolean

/**
 * Check if JP models are available for the given precision.
 * 结果会被缓存直到 invalidateJpModelsCache() 被调用。
 */
function checkJpModelsExist(baseDir, precision) {
  const cacheKey = `${baseDir}|${precision}`;
  if (_jpModelsExistCache.has(cacheKey)) {
    return _jpModelsExistCache.get(cacheKey);
  }
  const manifest = JP_MODEL_FILE_MANIFEST;
  let allExist = true;
  for (const file of manifest) {
    const fullPath = getJpLocalFilePath(baseDir, file.filePath, precision);
    try {
      const stats = fs.statSync(fullPath);
      if (stats.size <= 0) { allExist = false; break; }
    } catch (_) {
      allExist = false; break;
    }
  }
  _jpModelsExistCache.set(cacheKey, allExist);
  return allExist;
}

/**
 * 失效 JP 模型存在性缓存。在 JP 模型下载完成或删除后调用。
 * 不传参数时清空全部缓存。
 */
function invalidateJpModelsCache(baseDir, precision) {
  if (baseDir && precision) {
    _jpModelsExistCache.delete(`${baseDir}|${precision}`);
  } else {
    _jpModelsExistCache.clear();
  }
}

function getFileDownloadUrl(filePath, precision, revision) {
  if (!revision) return null;
  // Preprocess and basic_pitch models use int8 repo (dynamic shapes),
  // not int8-npu repo (static shapes with fixed input dimensions)
  const effectivePrecision = (!isSvsModelFile(filePath) && precision === 'int8-npu') ? 'int8' : precision;
  const modelId = getModelId(effectivePrecision);
  if (!modelId) return null;  // precision not yet available for download
  const encoded = encodeURIComponent(filePath);
  return `${MODELSCOPE_ENDPOINT}/api/v1/models/${modelId}/repo?Revision=${encodeURIComponent(revision)}&FilePath=${encoded}`;
}

/**
 * 列出 ModelScope 仓库中所有 blob 文件的路径。
 * 用于智能检测远程模型是「分开的 onnx+data」还是「单 onnx 文件」。
 *
 * 策略：
 *   1. 首选查询指定 revision（如 v1）的文件列表
 *   2. 若该 revision 返回空（部分 tag 的 Files 字段为 null），
 *      回退到 master 分支查询（文件结构通常一致）
 *   3. 若仍失败，返回 null —— 调用方应回退到本地硬编码清单
 *
 * @param {string} modelId  ModelScope 仓库 ID（如 'syxppp/SoulX-Singer-onnx-directml-fp16'）
 * @param {string} revision tag 名（如 'v1'）
 * @returns {Promise<Set<string>|null>} 文件路径集合，null 表示无法确定
 */
async function listModelFiles(modelId, revision) {
  if (!modelId || !revision) return null;
  const fetch = async (rev) => {
    const url = `${MODELSCOPE_ENDPOINT}/api/v1/models/${modelId}/repo/files?Revision=${encodeURIComponent(rev)}`;
    const data = await _fetchModelScopeJson(url);
    if (data && data.Success && data.Data && Array.isArray(data.Data.Files)) {
      const set = new Set();
      for (const f of data.Data.Files) {
        if (f && f.Type === 'blob' && typeof f.Path === 'string') {
          set.add(f.Path);
        }
      }
      return set;
    }
    return null;
  };
  // 1. 指定 revision
  let files = null;
  try { files = await fetch(revision); } catch (_) { files = null; }
  if (files && files.size > 0) return files;
  // 2. 回退 master（仅当 revision 本身不是 master 时）
  if (revision !== 'master') {
    try { files = await fetch('master'); } catch (_) { files = null; }
    if (files && files.size > 0) return files;
  }
  // 3. 无法确定
  return null;
}

/**
 * 根据 ModelScope 远程文件列表，智能调整缺失文件清单：
 *
 * 1. 过滤：移除远程不存在的文件（如「单 onnx 文件」仓库中清单里的 .onnx.data）
 * 2. 补充：对于清单中缺失的 .onnx 文件，若远程存在对应 .onnx.data 且本地也没有，
 *          则将 .onnx.data 加入下载列表（「连带 data 一起下载」）
 *
 * 这让下载逻辑不再依赖硬编码的 PRECISION_NO_EXTERNAL_DATA：
 *   - 若远程存在 xxx.onnx 与 xxx.onnx.data → 保留两者（连带下载）
 *   - 若远程只有 xxx.onnx（权重自包含）→ 移除 xxx.onnx.data，避免下载失败
 *   - 若清单因 PRECISION_NO_EXTERNAL_DATA 过滤了 data，但远程实际有 data → 补回
 *
 * 注意：preprocess/ 与 basic_pitch_model/ 前缀的文件使用 int8 仓库，
 *       而主 SVS 模型文件使用 precision 对应的仓库，因此需要分别查询。
 *
 * 容错：若远程文件列表获取失败（返回 null），返回原清单不变，
 *       回退到当前硬编码清单行为。
 *
 * @param {Array} missingFiles  缺失文件数组（元素含 filePath 字段）
 * @param {string} modelDir     模型根目录（用于检查本地 data 文件是否存在）
 * @param {string} precision    当前精度
 * @param {string} revision     ModelScope tag
 * @returns {Promise<Array>}    调整后的缺失文件数组
 */
async function filterMissingByRemote(missingFiles, modelDir, precision, revision) {
  if (!missingFiles || missingFiles.length === 0) return missingFiles;

  // 主 SVS 模型仓库（precision 对应）与 preprocess/basic_pitch 仓库（int8）可能不同，
  // 分别查询。int8-npu 的 preprocess/basic_pitch 走 int8 仓库（getFileDownloadUrl 逻辑）。
  const svsModelId = getModelId(precision);
  const auxPrecision = precision === 'int8-npu' ? 'int8' : precision;
  const auxModelId = getModelId(auxPrecision);
  const sameRepo = !auxModelId || auxModelId === svsModelId;

  const [svsSet, auxSetRaw] = await Promise.all([
    svsModelId ? listModelFiles(svsModelId, revision) : Promise.resolve(null),
    auxModelId && !sameRepo ? listModelFiles(auxModelId, revision) : Promise.resolve(null),
  ]);
  // 仓库相同时复用同一结果
  const auxSet = sameRepo ? svsSet : auxSetRaw;

  // 两个列表都拿不到 → 回退到原清单
  if (!svsSet && !auxSet) {
    console.log('[ModelManager] Remote file list unavailable, using manifest as-is');
    return missingFiles;
  }

  // 阶段 1：过滤掉远程不存在的文件
  const filtered = [];
  const skipped = [];
  for (const file of missingFiles) {
    const isSvs = isSvsModelFile(file.filePath);
    const remoteSet = isSvs ? svsSet : auxSet;
    if (!remoteSet) {
      // 该仓库的远程列表拿不到 → 保留原文件（不因探测失败而丢弃）
      filtered.push(file);
      continue;
    }
    if (remoteSet.has(file.filePath)) {
      filtered.push(file);
    } else {
      skipped.push(file.filePath);
    }
  }

  // 阶段 2：补充远程存在但清单中没有的 .onnx.data（连带 data 一起下载）
  // 典型场景：int8-npu 的 PRECISION_NO_EXTERNAL_DATA 过滤了所有 data，
  // 但远程实际有小模型的 data 文件 → 补回
  const existingPaths = new Set(filtered.map(f => f.filePath));
  const added = [];
  for (const file of filtered) {
    // 只对 .onnx 文件（非 .onnx.data 自身）检查是否有配套 data
    if (!file.filePath.endsWith('.onnx')) continue;
    const dataPath = file.filePath + '.data';
    if (existingPaths.has(dataPath)) continue; // 已在列表中
    const isSvs = isSvsModelFile(file.filePath);
    const remoteSet = isSvs ? svsSet : auxSet;
    if (!remoteSet || !remoteSet.has(dataPath)) continue; // 远程没有 data
    // 检查本地是否已有该 data 文件（避免重复下载）
    const localDataPath = getLocalFilePath(modelDir, dataPath, precision);
    let localExists = false;
    try {
      const stats = fs.statSync(localDataPath);
      if (stats.size > 0) localExists = true;
    } catch (_) {}
    if (localExists) continue;
    // 远程有 data 且本地缺失 → 连带下载
    added.push({ ...file, filePath: dataPath, required: true });
    existingPaths.add(dataPath);
  }

  if (skipped.length > 0) {
    console.log(`[ModelManager] Remote check: skipped ${skipped.length} file(s) not present on ModelScope:`, skipped);
  }
  if (added.length > 0) {
    console.log(`[ModelManager] Remote check: added ${added.length} external data file(s) for bundled download:`, added.map(f => f.filePath));
  }
  return filtered.concat(added);
}

/**
 * Get the download URL for a JP language model file.
 */
function getJpFileDownloadUrl(filePath, precision, revision) {
  if (!revision) return null;
  const modelId = getJpModelId(precision);
  if (!modelId) return null;
  const encoded = encodeURIComponent(filePath);
  return `${MODELSCOPE_ENDPOINT}/api/v1/models/${modelId}/repo?Revision=${encodeURIComponent(revision)}&FilePath=${encoded}`;
}

/**
 * Get the download URL for a SiFiGAN model file.
 * SiFiGAN files live in their own ModelScope repo (MODEL_IDS.sifigan)
 * and are stored at the root of onnx_models/ (not in precision subdirs).
 */
function getSifiganFileDownloadUrl(filePath, revision) {
  if (!revision) return null;
  const modelId = MODEL_IDS.sifigan;
  if (!modelId) return null;
  const encoded = encodeURIComponent(filePath);
  return `${MODELSCOPE_ENDPOINT}/api/v1/models/${modelId}/repo?Revision=${encodeURIComponent(revision)}&FilePath=${encoded}`;
}

// ===== ModelScope tag (version) listing =====
// ModelScope model repos are git-based. Downloads are tag-only — the default
// branch ('master') is NOT used. Tags represent specific released versions
// (e.g. 'v0', 'v1', 'v2').
// The revisions API: GET /api/v1/models/{model_id}/revisions
//   → { Data: { RevisionMap: { Branches: [...], Tags: [...] } } }
// Only tags are surfaced as selectable versions; branches are NOT shown.

/**
 * Fetch a JSON document from ModelScope API via GET request.
 * Returns parsed JSON object or null on failure.
 */
async function _fetchModelScopeJson(url) {
  try {
    const { response } = await resolveRedirects(url, 5, 'GET');
    const chunks = [];
    for await (const chunk of response) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf-8');
    return JSON.parse(body);
  } catch (err) {
    console.warn('[ModelManager] ModelScope API request failed:', err.message);
    return null;
  }
}

/**
 * Extract tag names from a ModelScope revisions API response.
 * Returns an array of tag name strings (e.g. ['v2', 'v1.0']).
 * Returns [] if no tags exist or the response shape is unexpected.
 */
function _extractTags(data) {
  if (!data || !data.Success || !data.Data) return [];
  const revisionMap = (data.Data.RevisionMap) || {};
  const tags = Array.isArray(revisionMap.Tags) ? revisionMap.Tags : [];
  return tags
    .map((t) => (t && typeof t === 'object' && t.Revision) ? t.Revision : null)
    .filter((t) => typeof t === 'string' && t.length > 0);
}

/**
 * Fetch available tags (versions) for a main model precision from ModelScope.
 * Returns an array of tag names, e.g. ['v2', 'v1.0']. On failure returns [].
 * The default (latest, no tag) is represented separately as 'master'.
 */
async function getModelTags(precision) {
  const modelId = getModelId(precision);
  if (!modelId) return [];
  const url = `${MODELSCOPE_ENDPOINT}/api/v1/models/${modelId}/revisions`;
  const data = await _fetchModelScopeJson(url);
  return _extractTags(data);
}

/**
 * Fetch available tags for a JP model precision from ModelScope.
 */
async function getJpModelTags(precision) {
  const modelId = getJpModelId(precision);
  if (!modelId) return [];
  const url = `${MODELSCOPE_ENDPOINT}/api/v1/models/${modelId}/revisions`;
  const data = await _fetchModelScopeJson(url);
  return _extractTags(data);
}

/**
 * Fetch available tags for the SiFiGAN model from ModelScope.
 */
async function getSifiganTags() {
  const modelId = MODEL_IDS.sifigan;
  if (!modelId) return [];
  const url = `${MODELSCOPE_ENDPOINT}/api/v1/models/${modelId}/revisions`;
  const data = await _fetchModelScopeJson(url);
  return _extractTags(data);
}

// ===== Version management functions =====

/**
 * Get the path to the version.json file for a given precision.
 * fp32 → modelDir/version.json
 * fp16 → modelDir/fp16/version.json
 * int8 → modelDir/int8/version.json
 * int8-npu → modelDir/int8/optimized_npu/version.json
 */
function getModelVersionPath(modelDir, precision) {
  if (precision && PRECISION_SUBDIR_PRECESIONS.has(precision)) {
    const subdir = PRECISION_SUBDIR_MAP[precision] || precision;
    return path.join(modelDir, subdir, VERSION_FILE_NAME);
  }
  return path.join(modelDir, VERSION_FILE_NAME);
}

/**
 * Get the path to the version.json file for JP models.
 * fp16 → modelDir/fp16/JP/version.json
 */
function getJpModelVersionPath(modelDir, precision) {
  if (precision && PRECISION_SUBDIR_PRECESIONS.has(precision)) {
    const subdir = PRECISION_SUBDIR_MAP[precision] || precision;
    return path.join(modelDir, subdir, 'JP', VERSION_FILE_NAME);
  }
  return path.join(modelDir, 'JP', VERSION_FILE_NAME);
}

/**
 * Get the path to the SiFiGAN version file.
 * SiFiGAN lives at the root of onnx_models/, uses a dedicated file to avoid
 * collision with the main model version.json.
 */
function getSifiganVersionPath(modelDir) {
  return path.join(modelDir, 'sifigan_version.json');
}

/**
 * Normalize a version string into an array of integers.
 * Handles 'v' prefix (e.g. 'v1' → [1]) and dot-separated segments
 * (e.g. '1.0.0' → [1, 0, 0], 'v2.1' → [2, 1]).
 */
function _normalizeVersion(v) {
  return String(v)
    .replace(/^v/i, '')
    .split('.')
    .map(n => parseInt(n, 10) || 0);
}

/**
 * Compare two version strings (e.g. '1.0.0' vs '1.2.0', 'v0' vs 'v1').
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const pa = _normalizeVersion(a);
  const pb = _normalizeVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * Pick the latest tag from a list of ModelScope version tags.
 * Tags are expected in 'v0', 'v1', ... format. Non-matching tags are ignored.
 * Returns the latest tag string (e.g. 'v2'), or null if none match.
 */
function getLatestTag(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  const valid = tags.filter(t => typeof t === 'string' && /^v?\d+/i.test(t));
  if (valid.length === 0) return null;
  valid.sort((a, b) => compareVersions(b, a)); // descending
  return valid[0];
}

/**
 * Read the local model version for a given precision.
 * Returns the version string (e.g. '1.0.0'), or null if version.json
 * does not exist (treated as a legacy model).
 */
function getLocalModelVersion(modelDir, precision) {
  const versionPath = getModelVersionPath(modelDir, precision);
  try {
    const data = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
    return data.version || null;
  } catch (_) {
    return null;
  }
}

/**
 * Read the local model revision (ModelScope tag) for a given precision.
 * Returns the tag name (e.g. 'v1'), or null if not recorded.
 * A 'master' value indicates a legacy branch-based install.
 */
function getLocalModelRevision(modelDir, precision) {
  const versionPath = getModelVersionPath(modelDir, precision);
  try {
    const data = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
    return data.revision || null;
  } catch (_) {
    return null;
  }
}

/**
 * Check if a model update is available for the given precision.
 * - Legacy models (no version.json or revision='master') are flagged for
 *   update as soon as any remote version tag exists. The latest tag is also
 *   fetched so the UI can display the version the user would update to.
 * - Tag-based installs (e.g. 'v1') are compared against the latest remote tag.
 * - Network failures do NOT flag an update (avoids false positives), but for
 *   legacy models the update flag stays true (legacy always needs updating).
 * Returns { updateAvailable, localVersion, latestVersion, hasModelFiles, localRevision }
 */
async function checkModelVersion(modelDir, precision) {
  const localVersion = getLocalModelVersion(modelDir, precision);
  const localRevision = getLocalModelRevision(modelDir, precision);
  const { existing } = checkMissingFiles(modelDir, precision);
  const hasModelFiles = existing.length > 0;

  let updateAvailable = false;
  let latestVersion = null;

  if (hasModelFiles) {
    const isLegacy = !localVersion || !localRevision || localRevision === 'master';
    if (isLegacy) {
      // Legacy model: flag for update only when a real remote version exists.
      // v0 or null latestVersion means no meaningful update (v0 is the
      // initial/legacy version with the same content), so we do NOT notify.
      updateAvailable = true;
      try {
        const tags = await getModelTags(precision);
        latestVersion = getLatestTag(tags);
      } catch (err) {
        console.warn(`[ModelManager] Failed to fetch remote tags for legacy ${precision}:`, err.message);
      }
    } else {
      // Specific tag installed → fetch remote tags and compare
      try {
        const tags = await getModelTags(precision);
        latestVersion = getLatestTag(tags);
        if (latestVersion && compareVersions(localRevision, latestVersion) < 0) {
          updateAvailable = true;
        }
      } catch (err) {
        console.warn(`[ModelManager] Failed to fetch remote tags for ${precision}:`, err.message);
      }
    }
  }

  // v0 or null latest means no real update available — v0 is the initial
  // version whose content is identical to legacy installs. Suppress the
  // update flag even for legacy models to avoid false notifications.
  const isLatestV0OrNull = !latestVersion || latestVersion === 'v0';
  if (isLatestV0OrNull) {
    updateAvailable = false;
  }

  return {
    updateAvailable,
    localVersion,
    latestVersion,
    hasModelFiles,
    localRevision,
    isLatestV0OrNull,
  };
}

/**
 * Save the model version to version.json after a successful download.
 * revision is the ModelScope tag (e.g. 'v1') that was downloaded.
 * The version field mirrors the revision so checkModelVersion can compare
 * localRevision against the latest remote tag.
 */
function saveModelVersion(modelDir, precision, revision) {
  if (!revision) {
    console.warn(`[ModelManager] saveModelVersion: revision is required`);
    return;
  }
  const versionPath = getModelVersionPath(modelDir, precision);
  try {
    const dir = path.dirname(versionPath);
    fs.mkdirSync(dir, { recursive: true });
    const data = {
      version: revision,
      precision,
      revision,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(versionPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[ModelManager] Saved version ${revision} (revision: ${revision}) for precision ${precision}`);
  } catch (err) {
    console.warn(`[ModelManager] Failed to save version for ${precision}:`, err.message);
  }
}

// ===== JP model version management =====

function getLocalJpModelVersion(modelDir, precision) {
  const versionPath = getJpModelVersionPath(modelDir, precision);
  try {
    const data = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
    return data.version || null;
  } catch (_) {
    return null;
  }
}

function getLocalJpModelRevision(modelDir, precision) {
  const versionPath = getJpModelVersionPath(modelDir, precision);
  try {
    const data = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
    return data.revision || null;
  } catch (_) {
    return null;
  }
}

async function checkJpModelVersion(modelDir, precision) {
  const localVersion = getLocalJpModelVersion(modelDir, precision);
  const localRevision = getLocalJpModelRevision(modelDir, precision);
  const hasModelFiles = checkJpModelsExist(modelDir, precision);

  let updateAvailable = false;
  let latestVersion = null;

  if (hasModelFiles) {
    const isLegacy = !localVersion || !localRevision || localRevision === 'master';
    if (isLegacy) {
      // Legacy JP model: flag for update only when a real remote version
      // exists. v0 or null latestVersion means no meaningful update.
      updateAvailable = true;
      try {
        const tags = await getJpModelTags(precision);
        latestVersion = getLatestTag(tags);
      } catch (err) {
        console.warn(`[ModelManager] Failed to fetch remote JP tags for legacy ${precision}:`, err.message);
      }
    } else {
      // Specific tag installed → fetch remote tags and compare
      try {
        const tags = await getJpModelTags(precision);
        latestVersion = getLatestTag(tags);
        if (latestVersion && compareVersions(localRevision, latestVersion) < 0) {
          updateAvailable = true;
        }
      } catch (err) {
        console.warn(`[ModelManager] Failed to fetch remote JP tags for ${precision}:`, err.message);
      }
    }
  }

  // v0 or null latest means no real update available — suppress notification
  // even for legacy models (v0 content is identical to legacy).
  const isLatestV0OrNull = !latestVersion || latestVersion === 'v0';
  if (isLatestV0OrNull) {
    updateAvailable = false;
  }

  return {
    updateAvailable,
    localVersion,
    latestVersion,
    hasModelFiles,
    localRevision,
    isLatestV0OrNull,
  };
}

function saveJpModelVersion(modelDir, precision, revision) {
  if (!revision) {
    console.warn(`[ModelManager] saveJpModelVersion: revision is required`);
    return;
  }
  const versionPath = getJpModelVersionPath(modelDir, precision);
  try {
    const dir = path.dirname(versionPath);
    fs.mkdirSync(dir, { recursive: true });
    const data = {
      version: revision,
      precision,
      revision,
      language: 'jp',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(versionPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[ModelManager] Saved JP version ${revision} (revision: ${revision}) for precision ${precision}`);
  } catch (err) {
    console.warn(`[ModelManager] Failed to save JP version for ${precision}:`, err.message);
  }
}

// ===== SiFiGAN version management =====

function getLocalSifiganVersion(modelDir) {
  const versionPath = getSifiganVersionPath(modelDir);
  try {
    const data = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
    return data.version || null;
  } catch (_) {
    return null;
  }
}

function getLocalSifiganRevision(modelDir) {
  const versionPath = getSifiganVersionPath(modelDir);
  try {
    const data = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
    return data.revision || null;
  } catch (_) {
    return null;
  }
}

async function checkSifiganVersion(modelDir) {
  const localVersion = getLocalSifiganVersion(modelDir);
  const localRevision = getLocalSifiganRevision(modelDir);
  // Check if SiFiGAN files exist by looking for stats + at least one variant
  let hasModelFiles = false;
  try {
    const statsPath = path.join(modelDir, 'sifigan_stats.joblib');
    const stats = fs.statSync(statsPath);
    const fp16Onnx = path.join(modelDir, 'sifigan_vocoder_dml_fp16.onnx');
    const fp32Onnx = path.join(modelDir, 'sifigan_vocoder_dml.onnx');
    const hasFp16 = fs.existsSync(fp16Onnx) && fs.statSync(fp16Onnx).size > 0;
    const hasFp32 = fs.existsSync(fp32Onnx) && fs.statSync(fp32Onnx).size > 0;
    hasModelFiles = stats.size > 0 && (hasFp16 || hasFp32);
  } catch (_) {}

  let updateAvailable = false;
  let latestVersion = null;

  if (hasModelFiles) {
    const isLegacy = !localVersion || !localRevision || localRevision === 'master';
    if (isLegacy) {
      // Legacy SiFiGAN model: flag for update only when a real remote
      // version exists. v0 or null latestVersion means no meaningful update.
      updateAvailable = true;
      try {
        const tags = await getSifiganTags();
        latestVersion = getLatestTag(tags);
      } catch (err) {
        console.warn(`[ModelManager] Failed to fetch remote SiFiGAN tags for legacy:`, err.message);
      }
    } else {
      // Specific tag installed → fetch remote tags and compare
      try {
        const tags = await getSifiganTags();
        latestVersion = getLatestTag(tags);
        if (latestVersion && compareVersions(localRevision, latestVersion) < 0) {
          updateAvailable = true;
        }
      } catch (err) {
        console.warn(`[ModelManager] Failed to fetch remote SiFiGAN tags:`, err.message);
      }
    }
  }

  // v0 or null latest means no real update available — suppress notification
  // even for legacy models (v0 content is identical to legacy).
  const isLatestV0OrNull = !latestVersion || latestVersion === 'v0';
  if (isLatestV0OrNull) {
    updateAvailable = false;
  }

  return {
    updateAvailable,
    localVersion,
    latestVersion,
    hasModelFiles,
    localRevision,
    isLatestV0OrNull,
  };
}

function saveSifiganVersion(modelDir, revision) {
  if (!revision) {
    console.warn(`[ModelManager] saveSifiganVersion: revision is required`);
    return;
  }
  const versionPath = getSifiganVersionPath(modelDir);
  try {
    const data = {
      version: revision,
      revision,
      model: 'sifigan',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(versionPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[ModelManager] Saved SiFiGAN version ${revision} (revision: ${revision})`);
  } catch (err) {
    console.warn(`[ModelManager] Failed to save SiFiGAN version:`, err.message);
  }
}

function checkMissingFiles(modelDir, precision) {
  const missing = [];
  const existing = [];
  const manifest = getManifestForPrecision(precision);

  for (const file of manifest) {
    if (!file.required) continue;
    const fullPath = getLocalFilePath(modelDir, file.filePath, precision);
    let exists = false;
    let localSize = 0;
    try {
      const stats = fs.statSync(fullPath);
      if (stats.size > 0) {
        exists = true;
        localSize = stats.size;
      }
    } catch (_) {}

    if (exists) {
      existing.push({ ...file, localSize });
    } else {
      let downloadedBytes = 0;
      try {
        const tempStats = fs.statSync(fullPath + TEMP_SUFFIX);
        downloadedBytes = tempStats.size;
      } catch (_) {}
      missing.push({ ...file, downloadedBytes });
    }
  }

  return { missing, existing };
}

/**
 * Check for missing JP language model files.
 */
function checkMissingJpFiles(modelDir, precision) {
  const missing = [];
  const existing = [];
  const manifest = JP_MODEL_FILE_MANIFEST;

  for (const file of manifest) {
    if (!file.required) continue;
    const fullPath = getJpLocalFilePath(modelDir, file.filePath, precision);
    let exists = false;
    let localSize = 0;
    try {
      const stats = fs.statSync(fullPath);
      if (stats.size > 0) {
        exists = true;
        localSize = stats.size;
      }
    } catch (_) {}

    if (exists) {
      existing.push({ ...file, localSize });
    } else {
      let downloadedBytes = 0;
      try {
        const tempStats = fs.statSync(fullPath + TEMP_SUFFIX);
        downloadedBytes = tempStats.size;
      } catch (_) {}
      missing.push({ ...file, downloadedBytes });
    }
  }

  return { missing, existing };
}

async function checkMissingFilesAsync(modelDir, precision) {
  const manifest = getManifestForPrecision(precision);
  const requiredFiles = manifest.filter(f => f.required);
  const results = await Promise.all(requiredFiles.map(async (file) => {
    const fullPath = getLocalFilePath(modelDir, file.filePath, precision);
    try {
      const stats = await fs.promises.stat(fullPath);
      if (stats.size > 0) {
        return { type: 'existing', file, localSize: stats.size };
      }
    } catch (_) {}
    let downloadedBytes = 0;
    try {
      const tempStats = await fs.promises.stat(fullPath + TEMP_SUFFIX);
      downloadedBytes = tempStats.size;
    } catch (_) {}
    return { type: 'missing', file, downloadedBytes };
  }));

  const missing = [];
  const existing = [];
  for (const r of results) {
    if (r.type === 'existing') {
      existing.push({ ...r.file, localSize: r.localSize });
    } else {
      missing.push({ ...r.file, downloadedBytes: r.downloadedBytes });
    }
  }
  return { missing, existing };
}

function deleteModelFiles(modelDir, precision) {
  if (!modelDir || typeof modelDir !== 'string') return { deleted: [], errors: [] };
  const deleted = [];
  const errors = [];
  const manifest = getManifestForPrecision(precision);

  for (const file of manifest) {
    const fullPath = getLocalFilePath(modelDir, file.filePath, precision);
    // 删除主文件
    for (const suffix of ['', TEMP_SUFFIX, CHUNK_META_SUFFIX]) {
      try {
        fs.unlinkSync(fullPath + suffix);
        if (!suffix) deleted.push(file.filePath);
      } catch (_) {}
    }
    // 删除分片下载的 part 文件
    for (let i = 0; i < MAX_GLOBAL_CONCURRENCY; i++) {
      try { fs.unlinkSync(fullPath + CHUNK_PART_SUFFIX + i); } catch (_) {}
    }
  }

  return { deleted, errors };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 根据硬件环境智能配置最佳并发数
 * - CPU 核心数 * 2 作为基础并发
 * - 内存不足时降低并发
 * - 最大不超过 16
 */
function getOptimalConcurrency() {
  const cpus = os.cpus().length;
  const totalMemGB = os.totalmem() / (1024 * 1024 * 1024);

  let concurrency = Math.max(4, Math.min(cpus * 2, MAX_GLOBAL_CONCURRENCY));

  if (totalMemGB < 4) {
    concurrency = Math.min(concurrency, 4);
  } else if (totalMemGB < 8) {
    concurrency = Math.min(concurrency, 8);
  }

  return concurrency;
}

/**
 * 根据文件大小动态计算最优分片大小
 * 分片太小会导致 HTTP 连接开销大、性能差；分片太大会导致单片失败重传代价高
 * 目标：分片数量控制在 4~16 之间，大文件使用更大的分片
 */
function getOptimalChunkSize(fileSize) {
  const MB = 1024 * 1024;
  if (fileSize < 64 * MB) return 16 * MB;       // 16~64MB: 16MB/片, 1~4片
  if (fileSize < 256 * MB) return 32 * MB;      // 64~256MB: 32MB/片, 2~8片
  if (fileSize < 1024 * MB) return 64 * MB;     // 256MB~1GB: 64MB/片, 4~16片
  return 128 * MB;                               // >1GB: 128MB/片, 8+片
}

/**
 * 并发池 - 控制全局最大并发连接数
 * 文件级和分片级共享同一个池，自然平衡并发
 */
class ConcurrencyPool {
  constructor(max) {
    this.max = max;
    this.running = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release() {
    this.running--;
    if (this.queue.length > 0) {
      this.running++;
      const next = this.queue.shift();
      next();
    }
  }
}

function httpRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch (e) {
      reject(new Error(`Invalid URL: ${urlStr}`));
      return;
    }

    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || defaultPort,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        ...options.headers,
      },
    };

    const request = lib.request(reqOptions, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = new URL(response.headers.location, urlStr).href;
        resolve({ redirectUrl, response });
        return;
      }
      resolve({ redirectUrl: null, response });
    });

    request.on('error', reject);

    if (options.timeout) {
      request.setTimeout(options.timeout, () => {
        request.destroy(new Error('Connection timeout'));
      });
    }

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        request.destroy();
        reject(new Error('Download cancelled'));
        return;
      }
      options.abortSignal.addEventListener('abort', () => {
        request.destroy();
      }, { once: true });
    }

    request.end();
  });
}

const ALLOWED_DOWNLOAD_HOSTS = [
  'modelscope.cn',
  'www.modelscope.cn',
  'cdn.modelscope.cn',
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
];

function isAllowedDownloadHost(urlStr) {
  try {
    const host = new URL(urlStr).hostname;
    return ALLOWED_DOWNLOAD_HOSTS.some(allowed => host === allowed || host.endsWith('.' + allowed));
  } catch (_) {
    return false;
  }
}

async function resolveRedirects(url, maxRedirects = 5, method = 'GET') {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    const { redirectUrl, response } = await httpRequest(currentUrl, { method, timeout: 10000 });
    if (!redirectUrl) {
      return { finalUrl: currentUrl, response };
    }
    if (!isAllowedDownloadHost(redirectUrl)) {
      throw new Error(`Redirect target not allowed: ${redirectUrl}`);
    }
    // Drain response body before following redirect
    response.resume();
    currentUrl = redirectUrl;
  }
  throw new Error('Too many redirects');
}

function downloadFromStream(response, destPath, startByte, expectedTotal, options = {}) {
  const { onProgress, abortSignal } = options;
  const tempPath = destPath + TEMP_SUFFIX;

  return new Promise((resolve, reject) => {
    const isResume = startByte > 0 && response.statusCode === 206;
    const effectiveStartByte = isResume ? startByte : 0;

    const flags = effectiveStartByte > 0 ? 'a' : 'w';
    const fileStream = fs.createWriteStream(tempPath, { flags });
    let currentBytes = effectiveStartByte;
    let lastProgressTime = 0;

    const contentLength = parseInt(response.headers['content-length'] || '0', 10);
    const totalSize = effectiveStartByte > 0 && response.statusCode === 206
      ? effectiveStartByte + contentLength
      : contentLength;

    response.on('data', (chunk) => {
      currentBytes += chunk.length;
      const now = Date.now();
      if (onProgress && (now - lastProgressTime > 100 || currentBytes === totalSize)) {
        lastProgressTime = now;
        onProgress(currentBytes, totalSize > 0 ? totalSize : currentBytes);
      }
    });

    response.pipe(fileStream);

    fileStream.on('finish', () => {
      fileStream.close(() => {
        if (totalSize > 0 && currentBytes < totalSize) {
          reject(new Error(`Incomplete download: ${currentBytes}/${totalSize} bytes`));
          return;
        }
        try {
          if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);
          }
          fs.renameSync(tempPath, destPath);
          resolve({ size: currentBytes });
        } catch (err) {
          reject(err);
        }
      });
    });

    fileStream.on('error', (err) => {
      try { fileStream.close(); } catch (_) {}
      reject(err);
    });

    response.on('error', (err) => {
      try { fileStream.close(); } catch (_) {}
      reject(err);
    });

    if (abortSignal) {
      if (abortSignal.aborted) {
        response.destroy();
        fileStream.close();
        reject(new Error('Download cancelled'));
        return;
      }
      abortSignal.addEventListener('abort', () => {
        response.destroy();
      }, { once: true });
    }
  });
}

async function downloadFileWithResume(url, destPath, options = {}) {
  const { onProgress, abortSignal, startByte: forceStartByte } = options;

  const tempPath = destPath + TEMP_SUFFIX;
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });

  let startByte = 0;
  try {
    const tempStats = fs.statSync(tempPath);
    startByte = tempStats.size;
  } catch (_) {}

  if (startByte === 0 && forceStartByte > 0) {
    startByte = forceStartByte;
  }

  const headers = {};
  if (startByte > 0) {
    headers['Range'] = `bytes=${startByte}-`;
  }

  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount < 5) {
    const { redirectUrl, response } = await httpRequest(currentUrl, {
      headers,
      timeout: 60000,
      abortSignal,
    });

    if (redirectUrl) {
      currentUrl = redirectUrl;
      redirectCount++;
      continue;
    }

    if (response.statusCode === 416) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
      if (headers['Range']) delete headers['Range'];
      startByte = 0;
      currentUrl = url;
      redirectCount = 0;
      continue;
    }

    if (response.statusCode !== 200 && response.statusCode !== 206) {
      throw new Error(`HTTP ${response.statusCode}`);
    }

    if (startByte > 0 && response.statusCode !== 206) {
      startByte = 0;
      delete headers['Range'];
    }

    return await downloadFromStream(response, destPath, startByte, 0, {
      onProgress,
      abortSignal,
    });
  }

  throw new Error('Too many redirects');
}

async function downloadFileWithRetry(url, destPath, options = {}) {
  const { maxRetries = MAX_RETRIES, ...rest } = options;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await downloadFileWithResume(url, destPath, rest);
    } catch (err) {
      lastError = err;
      if (err.message === 'Download cancelled') throw err;
      if (attempt < maxRetries) {
        console.warn(`[ModelManager] Download attempt ${attempt + 1} failed: ${err.message}, retrying...`);
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  throw lastError;
}

/**
 * 下载单个分片
 * 支持 Range 请求、重定向跟踪、断点续传（检查已完成的分片文件）
 */
async function downloadChunk(url, destPath, chunkIndex, start, end, options = {}) {
  const { abortSignal, onProgress } = options;
  const chunkPath = destPath + CHUNK_PART_SUFFIX + chunkIndex;
  const expectedSize = end - start + 1;

  // 检查分片是否已下载完成
  try {
    const stats = fs.statSync(chunkPath);
    if (stats.size === expectedSize) {
      if (onProgress) onProgress(chunkIndex, expectedSize, expectedSize);
      return { chunkIndex, size: expectedSize, resumed: true };
    }
  } catch (_) {}

  const headers = { 'Range': `bytes=${start}-${end}` };
  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount < 5) {
    if (abortSignal && abortSignal.aborted) {
      throw new Error('Download cancelled');
    }

    const { redirectUrl, response } = await httpRequest(currentUrl, {
      headers,
      timeout: 60000,
      abortSignal,
    });

    if (redirectUrl) {
      currentUrl = redirectUrl;
      redirectCount++;
      continue;
    }

    // 服务器不支持 Range 请求，返回 200 而非 206
    if (response.statusCode === 200) {
      response.resume();
      throw new Error('NO_RANGE_SUPPORT');
    }

    if (response.statusCode !== 206) {
      response.resume();
      throw new Error(`HTTP ${response.statusCode}`);
    }

    // 下载分片
    return new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(chunkPath, { flags: 'w' });
      let downloaded = 0;
      let lastProgressTime = 0;

      response.on('data', (data) => {
        downloaded += data.length;
        const now = Date.now();
        if (onProgress && (now - lastProgressTime > 200 || downloaded >= expectedSize)) {
          lastProgressTime = now;
          onProgress(chunkIndex, downloaded, expectedSize);
        }
      });

      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          if (downloaded < expectedSize) {
            reject(new Error(`Chunk ${chunkIndex} incomplete: ${downloaded}/${expectedSize}`));
            return;
          }
          resolve({ chunkIndex, size: downloaded, resumed: false });
        });
      });

      fileStream.on('error', (err) => {
        try { fileStream.close(); } catch (_) {}
        reject(err);
      });

      response.on('error', (err) => {
        try { fileStream.close(); } catch (_) {}
        reject(err);
      });

      if (abortSignal) {
        if (abortSignal.aborted) {
          response.destroy();
          fileStream.close();
          reject(new Error('Download cancelled'));
          return;
        }
        abortSignal.addEventListener('abort', () => {
          response.destroy();
        }, { once: true });
      }
    });
  }

  throw new Error('Too many redirects');
}

/**
 * 合并所有分片到目标文件（流式合并，内存友好）
 */
async function mergeChunks(destPath, numChunks) {
  const finalStream = fs.createWriteStream(destPath, { flags: 'w' });

  try {
    for (let i = 0; i < numChunks; i++) {
      const chunkPath = destPath + CHUNK_PART_SUFFIX + i;
      const chunkStream = fs.createReadStream(chunkPath);
      await pipeline(chunkStream, finalStream, { end: false });
      try { fs.unlinkSync(chunkPath); } catch (_) {}
    }
    await new Promise((resolve, reject) => {
      finalStream.on('finish', resolve);
      finalStream.on('error', reject);
      finalStream.end();
    });
  } catch (err) {
    finalStream.destroy();
    throw err;
  }
}

/**
 * 分片多线程下载大文件
 * - 将文件分成多个分片并行下载
 * - 每个分片使用全局并发池中的槽位
 * - 支持断点续传（通过 .download.meta 记录分片状态）
 * - 如果服务器不支持 Range 请求，抛出 NO_RANGE_SUPPORT 错误
 */
async function downloadFileChunked(url, destPath, fileSize, options = {}) {
  const { onProgress, abortSignal, pool } = options;
  const metaPath = destPath + CHUNK_META_SUFFIX;
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });

  // 根据文件大小动态计算分片布局
  const chunkSize = getOptimalChunkSize(fileSize);
  const maxChunks = Math.min(
    pool ? pool.max : MAX_GLOBAL_CONCURRENCY,
    Math.ceil(fileSize / chunkSize)
  );
  const numChunks = Math.max(1, maxChunks);
  const actualChunkSize = Math.ceil(fileSize / numChunks);

  // 构建分片列表
  const chunks = [];
  for (let i = 0; i < numChunks; i++) {
    const start = i * actualChunkSize;
    const end = Math.min(start + actualChunkSize - 1, fileSize - 1);
    chunks.push({ index: i, start, end, completed: false });
  }

  // 检查已有的元数据文件（断点续传）
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.fileSize === fileSize && meta.chunks && meta.chunks.length === numChunks) {
      for (let i = 0; i < numChunks; i++) {
        if (meta.chunks[i].completed) {
          // 验证分片文件确实存在且大小正确
          const chunkPath = destPath + CHUNK_PART_SUFFIX + i;
          try {
            const stats = fs.statSync(chunkPath);
            if (stats.size === (chunks[i].end - chunks[i].start + 1)) {
              chunks[i].completed = true;
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  // 保存元数据
  const saveMeta = () => {
    const meta = {
      fileSize,
      numChunks,
      chunks: chunks.map(c => ({
        index: c.index,
        start: c.start,
        end: c.end,
        completed: c.completed,
      })),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  };
  saveMeta();

  // 跟踪每个分片的下载进度
  const chunkDownloaded = new Array(numChunks).fill(0);
  for (const chunk of chunks) {
    if (chunk.completed) {
      chunkDownloaded[chunk.index] = chunk.end - chunk.start + 1;
    }
  }

  let lastProgressTime = 0;
  const reportProgress = () => {
    if (!onProgress) return;
    const now = Date.now();
    if (now - lastProgressTime < 100) return;
    lastProgressTime = now;
    const totalDownloaded = chunkDownloaded.reduce((a, b) => a + b, 0);
    onProgress(totalDownloaded, fileSize);
  };

  // 带重试的分片下载
  const downloadChunkWithRetry = async (chunk) => {
    if (chunk.completed) return;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (pool) await pool.acquire();
        try {
          await downloadChunk(url, destPath, chunk.index, chunk.start, chunk.end, {
            abortSignal,
            onProgress: (chunkIdx, downloaded, total) => {
              chunkDownloaded[chunkIdx] = downloaded;
              reportProgress();
            },
          });
          chunk.completed = true;
          chunkDownloaded[chunk.index] = chunk.end - chunk.start + 1;
          saveMeta();
          reportProgress();
          return;
        } finally {
          if (pool) pool.release();
        }
      } catch (err) {
        if (err.message === 'Download cancelled') throw err;
        if (err.message === 'NO_RANGE_SUPPORT') throw err;
        if (attempt < MAX_RETRIES) {
          console.warn(`[ModelManager] Chunk ${chunk.index} attempt ${attempt + 1} failed: ${err.message}, retrying...`);
          await sleep(RETRY_DELAY_MS * (attempt + 1));
        } else {
          throw err;
        }
      }
    }
  };

  try {
    // 并行下载所有未完成的分片
    await Promise.all(chunks.map(chunk => downloadChunkWithRetry(chunk)));
  } catch (err) {
    if (err.message === 'NO_RANGE_SUPPORT') {
      // 服务器不支持 Range，清理分片文件，让调用方回退到单线程
      for (let i = 0; i < numChunks; i++) {
        try { fs.unlinkSync(destPath + CHUNK_PART_SUFFIX + i); } catch (_) {}
      }
      try { fs.unlinkSync(metaPath); } catch (_) {}
      throw err;
    }
    throw err;
  }

  // 合并分片
  await mergeChunks(destPath, numChunks);

  // 清理临时文件
  try { fs.unlinkSync(metaPath); } catch (_) {}
  try { fs.unlinkSync(destPath + TEMP_SUFFIX); } catch (_) {}

  return { size: fileSize };
}

async function checkModelScopeCLIAvailable() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'modelscope.exe' : 'modelscope';
    execFile(cmd, ['--version'], { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}

async function downloadWithModelScopeCLI(modelDir, missingFiles, options = {}) {
  const { abortSignal, precision, revision = 'master' } = options;
  const modelId = getModelId(precision);
  const args = ['download', '--model', modelId, '--local_dir', modelDir];
  if (revision && revision !== 'master') {
    args.push('--revision', revision);
  }

  for (const file of missingFiles) {
    args.push('--include', file.filePath);
  }

  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'modelscope.exe' : 'modelscope';
    const child = execFile(cmd, args, { timeout: 0, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) {
          reject(new Error('Download cancelled'));
        } else {
          reject(error);
        }
        return;
      }
      resolve(stdout);
    });

    if (abortSignal) {
      if (abortSignal.aborted) {
        child.kill();
        reject(new Error('Download cancelled'));
        return;
      }
      abortSignal.addEventListener('abort', () => {
        child.kill();
      }, { once: true });
    }
  });
}

async function getRemoteFileSize(filePath, precision, revision = 'master') {
  const url = getFileDownloadUrl(filePath, precision, revision);
  try {
    const { response } = await resolveRedirects(url, 5, 'HEAD');
    const contentLength = parseInt(response.headers['content-length'] || '0', 10);
    response.resume();
    if (contentLength > 0) return contentLength;
  } catch (_) {}
  // HEAD unsupported or returned 0 — fall back to GET
  console.warn(`[ModelManager] HEAD failed for ${filePath}, falling back to GET`);
  try {
    const { response } = await resolveRedirects(url, 5, 'GET');
    const contentLength = parseInt(response.headers['content-length'] || '0', 10);
    response.resume();
    return contentLength;
  } catch (_) {
    return 0;
  }
}

/**
 * 下载缺失的模型文件
 * - 多文件并发下载
 * - 大文件（>=16MB）自动分片多线程下载
 * - 全局并发池控制最大连接数（智能配置，最大16）
 * - 支持断点续传
 */
async function downloadMissingFiles(modelDir, missingFiles, options = {}) {
  const { onProgress, onFileStart, onFileComplete, onFilesResolved, abortSignal, precision = DEFAULT_PRECISION, revision = 'master' } = options;

  if (missingFiles.length === 0) return;

  // 智能检测远程仓库实际文件结构：
  //   - 移除远程不存在的 .onnx.data（单 onnx 文件仓库）
  //   - 补充远程存在但清单中没有的 .onnx.data（连带 data 一起下载）
  // 远程列表不可用时回退到本地清单。
  missingFiles = await filterMissingByRemote(missingFiles, modelDir, precision, revision);
  if (missingFiles.length === 0) {
    console.log('[ModelManager] All missing files filtered out by remote check (single onnx, no external data)');
    saveModelVersion(modelDir, precision, revision);
    return;
  }
  // 通知调用方调整后的最终文件列表（让 UI 显示补充的 data 文件）
  if (onFilesResolved) onFilesResolved(missingFiles);

  const usePrecisionSubdir = precision && PRECISION_SUBDIR_PRECESIONS.has(precision);
  const cliAvailable = !usePrecisionSubdir && await checkModelScopeCLIAvailable();
  if (cliAvailable) {
    console.log('[ModelManager] ModelScope CLI available, using CLI download');
    try {
      await downloadWithModelScopeCLI(modelDir, missingFiles, { abortSignal, precision, revision });
      console.log('[ModelManager] ModelScope CLI download complete');
      saveModelVersion(modelDir, precision, revision);
      return;
    } catch (err) {
      if (err.message === 'Download cancelled') throw err;
      console.warn('[ModelManager] ModelScope CLI download failed, falling back to HTTP:', err.message);
    }
  }

  const globalConcurrency = getOptimalConcurrency();
  console.log(`[ModelManager] Using HTTP download with concurrent chunked support (concurrency: ${globalConcurrency}, revision: ${revision})`);
  const pool = new ConcurrencyPool(globalConcurrency);

  // 获取所有文件的远程大小（并行 HEAD 请求）
  const fileSizes = {};
  let overallTotal = 0;
  const sizeResults = await Promise.all(
    missingFiles.map(file => getRemoteFileSize(file.filePath, precision, revision))
  );
  for (let i = 0; i < missingFiles.length; i++) {
    fileSizes[missingFiles[i].filePath] = sizeResults[i];
    overallTotal += sizeResults[i];
  }

  // 跟踪每个文件的下载进度
  const fileDownloadedMap = new Map();
  const fileIndexMap = new Map();
  missingFiles.forEach((file, index) => {
    fileDownloadedMap.set(file.filePath, 0);
    fileIndexMap.set(file.filePath, index);
  });

  let lastProgressTime = 0;
  const reportOverallProgress = (filePath) => {
    if (!onProgress) return;
    const now = Date.now();
    if (now - lastProgressTime < 100) return;
    lastProgressTime = now;

    let totalDownloaded = 0;
    for (const [, downloaded] of fileDownloadedMap) {
      totalDownloaded += downloaded;
    }

    onProgress({
      currentFile: filePath,
      fileIndex: fileIndexMap.get(filePath),
      totalFiles: missingFiles.length,
      bytesDownloaded: fileDownloadedMap.get(filePath) || 0,
      bytesTotal: fileSizes[filePath] || 0,
      overallDownloaded: totalDownloaded,
      overallTotal,
    });
  };

  // 并发下载所有文件
  const downloadPromises = missingFiles.map((file, index) => {
    return (async () => {
      if (abortSignal && abortSignal.aborted) {
        throw new Error('Download cancelled');
      }

      const destPath = getLocalFilePath(modelDir, file.filePath, precision);
      const url = getFileDownloadUrl(file.filePath, precision, revision);
      const fileSize = fileSizes[file.filePath];

      if (onFileStart) {
        onFileStart(file.filePath, index, missingFiles.length);
      }

      // 检查是否有旧的单线程临时文件（兼容旧版断点续传）
      const tempPath = destPath + TEMP_SUFFIX;
      const metaPath = destPath + CHUNK_META_SUFFIX;
      let hasOldTempFile = false;
      try {
        const stats = fs.statSync(tempPath);
        if (stats.size > 0) hasOldTempFile = true;
      } catch (_) {}

      // 决定是否使用分片下载
      // 条件：文件 >= 16MB 且没有旧的单线程临时文件（有旧临时文件则继续单线程续传）
      let useChunked = fileSize >= MIN_FILE_SIZE_FOR_CHUNKING && !hasOldTempFile && fileSize > 0;

      if (useChunked) {
        try {
          await downloadFileChunked(url, destPath, fileSize, {
            onProgress: (downloaded, total) => {
              fileDownloadedMap.set(file.filePath, downloaded);
              reportOverallProgress(file.filePath);
            },
            abortSignal,
            pool,
          });
        } catch (err) {
          if (err.message === 'NO_RANGE_SUPPORT') {
            console.warn(`[ModelManager] Server doesn't support Range for ${file.filePath}, falling back to single-threaded`);
            useChunked = false;
          } else {
            throw err;
          }
        }
      }

      if (!useChunked) {
        await downloadFileWithRetry(url, destPath, {
          onProgress: (downloaded, total) => {
            fileDownloadedMap.set(file.filePath, downloaded);
            reportOverallProgress(file.filePath);
          },
          abortSignal,
          startByte: file.downloadedBytes || 0,
        });
      }

      // 更新最终下载量
      try {
        const finalSize = (await fs.promises.stat(destPath)).size;
        fileDownloadedMap.set(file.filePath, finalSize);
      } catch (_) {}

      if (onFileComplete) {
        onFileComplete(file.filePath, index, missingFiles.length);
      }
    })();
  });

  const results = await Promise.allSettled(downloadPromises);

  // 检查是否有失败的下载
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (errors.length > 0) {
    throw errors[0];
  }

  // 下载成功后保存模型版本信息
  saveModelVersion(modelDir, precision, revision);
}

module.exports = {
  MODEL_FILE_MANIFEST,
  MODEL_IDS,
  JP_MODEL_IDS,
  JP_MODEL_FILE_MANIFEST,
  DEFAULT_PRECISION,
  MODELSCOPE_ENDPOINT,
  PRECISION_SUBDIR_MAP,
  PRECISION_SUBDIR_PRECESIONS,
  MIN_FILE_SIZE_FOR_CHUNKING,
  checkMissingFiles,
  checkMissingFilesAsync,
  checkMissingJpFiles,
  checkJpModelsExist,
  invalidateJpModelsCache,
  deleteModelFiles,
  downloadMissingFiles,
  downloadFileWithResume,
  downloadFileWithRetry,
  downloadFileChunked,
  checkModelScopeCLIAvailable,
  getFileDownloadUrl,
  getJpFileDownloadUrl,
  getSifiganFileDownloadUrl,
  getModelId,
  getJpModelId,
  getRemoteFileSize,
  getOptimalConcurrency,
  getLocalFilePath,
  getJpLocalFilePath,
  getManifestForPrecision,
  isSvsModelFile,
  isPrecisionDownloadable,
  // Remote file list (smart onnx+data detection)
  listModelFiles,
  filterMissingByRemote,
  // Tag (version) listing
  getModelTags,
  getJpModelTags,
  getSifiganTags,
  // Version management
  getModelVersionPath,
  getJpModelVersionPath,
  getSifiganVersionPath,
  compareVersions,
  getLatestTag,
  getLocalModelVersion,
  getLocalModelRevision,
  checkModelVersion,
  saveModelVersion,
  getLocalJpModelVersion,
  getLocalJpModelRevision,
  checkJpModelVersion,
  saveJpModelVersion,
  getLocalSifiganVersion,
  getLocalSifiganRevision,
  checkSifiganVersion,
  saveSifiganVersion,
};
