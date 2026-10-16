/**
 * ConfigStore —— 主进程"userData 下的小配置文件"唯一读写入口。
 *
 * 背景（审查项 A6）：配置持久化入口此前散落各处，同一个文件名被多处硬编码：
 *   · src/main/locale.js:194        sxseditor-locale.json
 *   · src/main/settings.js:536      sxseditor-locale.json
 *   · src/main/settingsIpc.js:494   sxseditor-locale.json
 *   · src/main/themeIpc.js          app.getPath('userData') 重复 6 次
 * 渲染侧 src/i18n/index.js 又单独存了一份 localStorage。任何一侧改名/换目录
 * 都会静默产生"两套配置不一致"的 bug。
 *
 * 这里统一约定：
 *   · 所有 userData 下的 JSON 配置文件名集中在本文件；
 *   · 写入走"临时文件 + rename"的原子替换，避免崩溃/断电留下半截 JSON；
 *   · 读取失败一律回退到 fallback 而不是抛向调用方（调用方本来就是这么做的）。
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/** userData 下的配置文件名登记表。新增配置文件请在这里登记，不要就地拼字符串。 */
const CONFIG_FILES = {
  locale: 'sxseditor-locale.json',
  // 历史文件名（src/main/settings.js 一直用的就是这个），不要重命名 —— 改名会让
  // 老用户的设置"凭空消失"。
  settings: 'settings.json',
};

/** userData 目录（懒解析：app 在测试环境里可能尚未 ready）。 */
function getUserDataDir() {
  try {
    return app.getPath('userData');
  } catch (_) {
    return path.join(require('node:os').tmpdir(), 'sxseditor-fallback-userdata');
  }
}

/** 取某个已登记配置文件的绝对路径。 */
function getConfigPath(name) {
  const file = CONFIG_FILES[name];
  if (!file) throw new Error(`[ConfigStore] 未登记的配置文件名: ${name}`);
  return path.join(getUserDataDir(), file);
}

/**
 * 读取 JSON 配置。文件不存在 / 损坏 / 不是对象时返回 fallback。
 * @param {keyof typeof CONFIG_FILES} name
 */
function readJsonConfig(name, fallback = null) {
  try {
    const configPath = getConfigPath(name);
    if (!fs.existsSync(configPath)) return fallback;
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (data && typeof data === 'object') ? data : fallback;
  } catch (err) {
    console.warn(`[ConfigStore] 读取 ${name} 配置失败，使用默认值:`, err && err.message);
    return fallback;
  }
}

/**
 * 原子写入 JSON 配置（写临时文件 → rename），避免半截 JSON 让下次启动崩溃。
 * @param {keyof typeof CONFIG_FILES} name
 * @returns {Promise<boolean>} 是否写成功
 */
async function writeJsonConfig(name, data) {
  const configPath = getConfigPath(name);
  const tmpPath = `${configPath}.${process.pid}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(tmpPath, JSON.stringify(data), 'utf8');
    await fs.promises.rename(tmpPath, configPath);
    return true;
  } catch (err) {
    console.warn(`[ConfigStore] 写入 ${name} 配置失败:`, err && err.message);
    try { await fs.promises.unlink(tmpPath); } catch (_) { /* 临时文件本来就没建成 */ }
    return false;
  }
}

/** 同步版原子写入，供启动早期（app ready 前）的调用点使用。 */
function writeJsonConfigSync(name, data) {
  const configPath = getConfigPath(name);
  const tmpPath = `${configPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
    fs.renameSync(tmpPath, configPath);
    return true;
  } catch (err) {
    console.warn(`[ConfigStore] 写入 ${name} 配置失败:`, err && err.message);
    try { fs.unlinkSync(tmpPath); } catch (_) { /* 同上 */ }
    return false;
  }
}

module.exports = {
  CONFIG_FILES,
  getUserDataDir,
  getConfigPath,
  readJsonConfig,
  writeJsonConfig,
  writeJsonConfigSync,
};
