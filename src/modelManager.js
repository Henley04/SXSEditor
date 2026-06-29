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
  fp8: '',  // placeholder — download link TBD
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
const REVISION = 'master';
const TEMP_SUFFIX = '.download';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

const PRECISION_SUBDIR_PRECESIONS = new Set(['int8', 'fp16', 'fp8', 'int8-npu']);

const PRECISION_SUBDIR_MAP = {
  'int8': 'int8',
  'fp16': 'fp16',
  'fp8': 'fp8',
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

/**
 * Check if JP models are available for the given precision.
 */
function checkJpModelsExist(baseDir, precision) {
  const manifest = JP_MODEL_FILE_MANIFEST;
  for (const file of manifest) {
    const fullPath = getJpLocalFilePath(baseDir, file.filePath, precision);
    try {
      const stats = fs.statSync(fullPath);
      if (stats.size <= 0) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

function getFileDownloadUrl(filePath, precision) {
  // Preprocess and basic_pitch models use int8 repo (dynamic shapes),
  // not int8-npu repo (static shapes with fixed input dimensions)
  const effectivePrecision = (!isSvsModelFile(filePath) && precision === 'int8-npu') ? 'int8' : precision;
  const modelId = getModelId(effectivePrecision);
  if (!modelId) return null;  // precision not yet available for download
  const encoded = encodeURIComponent(filePath);
  return `${MODELSCOPE_ENDPOINT}/api/v1/models/${modelId}/repo?Revision=${REVISION}&FilePath=${encoded}`;
}

/**
 * Get the download URL for a JP language model file.
 */
function getJpFileDownloadUrl(filePath, precision) {
  const modelId = getJpModelId(precision);
  if (!modelId) return null;
  const encoded = encodeURIComponent(filePath);
  return `${MODELSCOPE_ENDPOINT}/api/v1/models/${modelId}/repo?Revision=${REVISION}&FilePath=${encoded}`;
}

/**
 * Get the download URL for a SiFiGAN model file.
 * SiFiGAN files live in their own ModelScope repo (MODEL_IDS.sifigan)
 * and are stored at the root of onnx_models/ (not in precision subdirs).
 */
function getSifiganFileDownloadUrl(filePath) {
  const modelId = MODEL_IDS.sifigan;
  if (!modelId) return null;
  const encoded = encodeURIComponent(filePath);
  return `${MODELSCOPE_ENDPOINT}/api/v1/models/${modelId}/repo?Revision=${REVISION}&FilePath=${encoded}`;
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
  const { abortSignal, precision } = options;
  const modelId = getModelId(precision);
  const args = ['download', '--model', modelId, '--local_dir', modelDir];

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

async function getRemoteFileSize(filePath, precision) {
  const url = getFileDownloadUrl(filePath, precision);
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
  const { onProgress, onFileStart, onFileComplete, abortSignal, precision = DEFAULT_PRECISION } = options;

  if (missingFiles.length === 0) return;

  const usePrecisionSubdir = precision && PRECISION_SUBDIR_PRECESIONS.has(precision);
  const cliAvailable = !usePrecisionSubdir && await checkModelScopeCLIAvailable();
  if (cliAvailable) {
    console.log('[ModelManager] ModelScope CLI available, using CLI download');
    try {
      await downloadWithModelScopeCLI(modelDir, missingFiles, { abortSignal, precision });
      console.log('[ModelManager] ModelScope CLI download complete');
      return;
    } catch (err) {
      if (err.message === 'Download cancelled') throw err;
      console.warn('[ModelManager] ModelScope CLI download failed, falling back to HTTP:', err.message);
    }
  }

  const globalConcurrency = getOptimalConcurrency();
  console.log(`[ModelManager] Using HTTP download with concurrent chunked support (concurrency: ${globalConcurrency})`);
  const pool = new ConcurrencyPool(globalConcurrency);

  // 获取所有文件的远程大小（并行 HEAD 请求）
  const fileSizes = {};
  let overallTotal = 0;
  const sizeResults = await Promise.all(
    missingFiles.map(file => getRemoteFileSize(file.filePath, precision))
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
      const url = getFileDownloadUrl(file.filePath, precision);
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
};
