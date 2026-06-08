const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { checkMissingFiles } = require('../modelManager');

let customModelDir = null;

function getUnpackedModelDir() {
  let appPath = app.getAppPath();
  if (appPath.endsWith('.asar')) {
    appPath = appPath + '.unpacked';
  }
  return path.join(appPath, 'onnx_models') + path.sep;
}

function getModelDir() {
  if (!app.isPackaged) {
    return getUnpackedModelDir();
  }

  if (customModelDir) {
    try {
      fs.mkdirSync(customModelDir, { recursive: true });
    } catch (_) {}
    return customModelDir;
  }

  const unpackedDir = getUnpackedModelDir();
  const { missing } = checkMissingFiles(unpackedDir);
  if (missing.length === 0) {
    console.log('[Main] 在 app.asar.unpacked 中找到完整模型文件');
    return unpackedDir;
  }

  console.log('[Main] app.asar.unpacked 中模型文件不完整，缺少', missing.length, '个文件');
  const userDataDir = app.getPath('userData');
  const modelDir = path.join(userDataDir, 'onnx_models');
  fs.mkdirSync(modelDir, { recursive: true });
  return modelDir + path.sep;
}

function setCustomModelDir(dir) {
  customModelDir = dir;
}

function getCustomModelDir() {
  return customModelDir;
}

module.exports = {
  getModelDir,
  setCustomModelDir,
  getCustomModelDir,
  getUnpackedModelDir,
};
