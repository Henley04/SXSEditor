const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

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
  // 只检查核心 .onnx 文件是否存在，不检查 .onnx.data（int8-npu 模型已将数据自包含）
  const coreModelFile = path.join(unpackedDir, 'note_text_encoder.onnx');
  if (fs.existsSync(coreModelFile)) {
    console.log('[Main] Found complete model files in app.asar.unpacked');
    return unpackedDir;
  }

  console.log('[Main] Model files incomplete in app.asar.unpacked');
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
