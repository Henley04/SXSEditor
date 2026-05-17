const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { URL } = require('node:url');

const MODEL_ID = 'syxppp/SoulX-Singer-onnx-directml';
const MODELSCOPE_ENDPOINT = 'https://modelscope.cn';
const REVISION = 'master';
const TEMP_SUFFIX = '.download';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

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
  { filePath: 'vocoder.onnx', required: true },
  { filePath: 'mel_transform.onnx', required: true },
  { filePath: 'mel_transform.onnx.data', required: true },
  { filePath: 'preprocess/rmvpe_model.onnx', required: true },
  { filePath: 'preprocess/rmvpe_mel.onnx', required: false },
  { filePath: 'preprocess/rosvot_model.onnx', required: false },
  { filePath: 'basic_pitch_model/model.json', required: true },
  { filePath: 'basic_pitch_model/group1-shard1of1.bin', required: true },
];

function getFileDownloadUrl(filePath) {
  const encoded = encodeURIComponent(filePath);
  return `${MODELSCOPE_ENDPOINT}/api/v1/models/${MODEL_ID}/repo?Revision=${REVISION}&FilePath=${encoded}`;
}

function checkMissingFiles(modelDir) {
  const missing = [];
  const existing = [];

  for (const file of MODEL_FILE_MANIFEST) {
    if (!file.required) continue;
    const fullPath = path.join(modelDir, file.filePath);
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      headers: { ...options.headers },
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

async function resolveRedirects(url, maxRedirects = 5) {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    const { redirectUrl, response } = await httpRequest(currentUrl, { method: 'GET', timeout: 10000 });
    if (!redirectUrl) {
      return { finalUrl: currentUrl, response };
    }
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

async function checkModelScopeCLIAvailable() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'modelscope.exe' : 'modelscope';
    execFile(cmd, ['--version'], { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}

async function downloadWithModelScopeCLI(modelDir, missingFiles, options = {}) {
  const { abortSignal } = options;
  const args = ['download', '--model', MODEL_ID, '--local_dir', modelDir];

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

async function getRemoteFileSize(filePath) {
  const url = getFileDownloadUrl(filePath);
  try {
    const { finalUrl, response } = await resolveRedirects(url);
    const contentLength = parseInt(response.headers['content-length'] || '0', 10);
    response.resume();
    return contentLength;
  } catch (_) {
    return 0;
  }
}

async function downloadMissingFiles(modelDir, missingFiles, options = {}) {
  const { onProgress, onFileStart, onFileComplete, abortSignal } = options;

  if (missingFiles.length === 0) return;

  const cliAvailable = await checkModelScopeCLIAvailable();
  if (cliAvailable) {
    console.log('[ModelManager] ModelScope CLI available, using CLI download');
    try {
      await downloadWithModelScopeCLI(modelDir, missingFiles, { abortSignal });
      console.log('[ModelManager] ModelScope CLI download complete');
      return;
    } catch (err) {
      if (err.message === 'Download cancelled') throw err;
      console.warn('[ModelManager] ModelScope CLI download failed, falling back to HTTP:', err.message);
    }
  }

  console.log('[ModelManager] Using HTTP download');
  let overallDownloaded = 0;
  let overallTotal = 0;

  for (const file of missingFiles) {
    const remoteSize = await getRemoteFileSize(file.filePath);
    overallTotal += remoteSize;
  }

  for (let i = 0; i < missingFiles.length; i++) {
    if (abortSignal && abortSignal.aborted) {
      throw new Error('Download cancelled');
    }

    const file = missingFiles[i];
    const destPath = path.join(modelDir, file.filePath);
    const url = getFileDownloadUrl(file.filePath);

    if (onFileStart) {
      onFileStart(file.filePath, i, missingFiles.length);
    }

    await downloadFileWithRetry(url, destPath, {
      onProgress: (bytesDownloaded, bytesTotal) => {
        if (onProgress) {
          onProgress({
            currentFile: file.filePath,
            fileIndex: i,
            totalFiles: missingFiles.length,
            bytesDownloaded,
            bytesTotal,
            overallDownloaded: overallDownloaded + bytesDownloaded,
            overallTotal,
          });
        }
      },
      abortSignal,
      startByte: file.downloadedBytes || 0,
    });

    overallDownloaded += (await fs.promises.stat(destPath)).size;

    if (onFileComplete) {
      onFileComplete(file.filePath, i, missingFiles.length);
    }
  }
}

module.exports = {
  MODEL_FILE_MANIFEST,
  MODEL_ID,
  MODELSCOPE_ENDPOINT,
  checkMissingFiles,
  downloadMissingFiles,
  downloadFileWithResume,
  downloadFileWithRetry,
  checkModelScopeCLIAvailable,
  getFileDownloadUrl,
  getRemoteFileSize,
};
