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
 * 每次写入独立临时名。
 *
 * 历史实现是 `${configPath}.${process.pid}.tmp` —— **同一进程内并发写同一文件时
 * 临时路径完全相同**，于是后一个 writer 的 rename 找不到源文件（前一个已经把它
 * 搬走了），报：
 *
 *   ENOENT: no such file or directory, rename '…sxseditor-locale.json.42728.tmp'
 *                                    -> '…sxseditor-locale.json'
 *
 * 这在启动时必现：主窗口 / 设置窗口各自 renderer 的 i18n.setLocale 都会 invoke
 * save-locale。加序号后每个 writer 只碰自己的临时文件，剩下的并发问题（谁最后
 * 落盘）交给队列处理。
 */
let _writeSeq = 0;
function _tmpPathFor(configPath) {
  _writeSeq += 1;
  return `${configPath}.${process.pid}.${_writeSeq}.tmp`;
}

/** 每文件一条写队列，串行化同一配置文件的写入。 */
const _writeQueues = new Map();

/** rename 可能被 Windows 上的杀软/索引器短暂占用，重试几次即可。 */
const _RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const _RENAME_MAX_ATTEMPTS = 3;

async function _renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fs.promises.rename(from, to);
    } catch (err) {
      if (attempt >= _RENAME_MAX_ATTEMPTS || !_RENAME_RETRY_CODES.has(err && err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
}

/**
 * 磁盘上已经是这份内容吗？
 *
 * 启动时每个窗口都会把 locale 回写一遍，内容通常与磁盘完全一致。不判等的话
 * 每次启动都在 userData 里做几轮"建临时文件 + rename"，纯属自找噪声（还会
 * 让备份/同步工具反复扫描）。
 */
function _sameContentSync(configPath, json) {
  try {
    const current = fs.readFileSync(configPath, 'utf8');
    if (current === json) return true;
    return JSON.stringify(JSON.parse(current)) === json;
  } catch (_) {
    return false; // 不存在 / 读不了 / 不是合法 JSON —— 都照常写
  }
}

async function _sameContent(configPath, json) {
  try {
    const current = await fs.promises.readFile(configPath, 'utf8');
    if (current === json) return true;
    return JSON.stringify(JSON.parse(current)) === json;
  } catch (_) {
    return false;
  }
}

/** writeJsonConfig 的实际写盘部分（已在队列里串行执行）。 */
async function _writeJsonConfigNow(name, data) {
  const configPath = getConfigPath(name);
  let tmpPath = null;
  try {
    const json = JSON.stringify(data);
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    if (await _sameContent(configPath, json)) return true;
    tmpPath = _tmpPathFor(configPath);
    await fs.promises.writeFile(tmpPath, json, 'utf8');
    await _renameWithRetry(tmpPath, configPath);
    return true;
  } catch (err) {
    console.warn(`[ConfigStore] 写入 ${name} 配置失败:`, err && err.message);
    if (tmpPath) {
      try { await fs.promises.unlink(tmpPath); } catch (_) { /* 临时文件本来就没建成 */ }
    }
    return false;
  }
}

/**
 * 原子写入 JSON 配置（写临时文件 → rename），避免半截 JSON 让下次启动崩溃。
 * @param {keyof typeof CONFIG_FILES} name
 * @returns {Promise<boolean>} 是否写成功
 */
async function writeJsonConfig(name, data) {
  // 同一个配置文件会被多个窗口的 IPC 处理器并发写（启动时每个窗口的
  // i18n.setLocale 都会 invoke 一次 save-locale）。串行化到每文件一条队列上，
  // 既避免并发撞车，也保证"后发起的写"最终落盘 —— 否则慢的那个写可能
  // 覆盖掉用户刚改的新值。
  const prev = _writeQueues.get(name) || Promise.resolve();
  const next = prev.then(
    () => _writeJsonConfigNow(name, data),
    () => _writeJsonConfigNow(name, data),
  );
  _writeQueues.set(name, next.then(() => {}, () => {}));
  return next;
}

/** 同步版原子写入，供启动早期（app ready 前）的调用点使用。 */
function writeJsonConfigSync(name, data) {
  const configPath = getConfigPath(name);
  let tmpPath = null;
  try {
    const json = JSON.stringify(data);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (_sameContentSync(configPath, json)) return true;
    tmpPath = _tmpPathFor(configPath);
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, configPath);
    return true;
  } catch (err) {
    console.warn(`[ConfigStore] 写入 ${name} 配置失败:`, err && err.message);
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* 同上 */ }
    }
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
