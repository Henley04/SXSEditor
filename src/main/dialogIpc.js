const { dialog, BrowserWindow, shell, app } = require('electron');
const { authorizePath, authorizePathExact, isPathAllowed, isAuthorizedAncestor } = require('./security');
const { t } = require('./locale');
const fs = require('node:fs');
const path = require('node:path');
const { safeHandle } = require('./ipcSafe');

// file:authorizePath 允许渲染进程"自我授权"的最小路径集合。
//
// 这条 IPC 不能删：settings.js（探测 SiFiGAN 模型文件）、
// renderer/projectManager.js（重开工程时授权外部盘的伴奏/歌姬文件）、
// renderer/mcpAutomation.js（authorize() helper，MCP 自动化全部文件 I/O）
// 共 11 个调用点依赖它。因此按每个调用点的真实意图收窄放行规则：
//
//   A. 通用前置（目录和文件都要过）
//      1. 先用 fs.realpathSync 解析成真实路径，全部判断都基于真实路径做。
//         符号链接逃逸（Documents/link → ~/.ssh）在这一步就被还原成本体。
//         目标文件还不存在时回退为"父目录 realpath + 末段"，父目录不存在则拒绝。
//      2. 任一中间段不得以 '.' 开头（.ssh / .aws / .gnupg / .config）。
//      3. 任一中间段不得是 Windows 8.3 短名形态（^[A-Z0-9]{1,6}~[0-9]，
//         例如 SSH~1）—— 它不以 '.' 开头，能绕过第 2 条。realpathSync 在 Windows
//         上会把它展开成长名，这里再显式挡一次，双保险。
//      4. 不得命中敏感目录 denylist（见下方 SENSITIVE_* ），不得是系统路径。
//
//   B. 目录分支（mcpAutomation.authorize() 传目标路径的父目录、settings 授权模型目录）
//     目录不能裸放行了 —— 授权一个目录等于放行它下面的全部直接子文件，所以除了
//     A 之外还必须是"登记的目录"，四选一：
//       a. 位于安全根（userData / documents / desktop）之下：覆盖桌面与文档里的
//          导出目录、工程目录，这是绝大多数真实用法；
//       b. 是主进程登记的模型目录（可能在任意盘，用户自己在设置里挑的位置）；
//       c. 之前已经授权过（含祖先在白名单中）：保证同一目录重复授权不被拒绝；
//       d. 目录内存在白名单扩展名的素材文件：认定它是素材/工程目录，覆盖
//          重开工程时指向外部盘的工程/伴奏目录。
//     通过之后用 authorizePathExact() 只登记目录本身，不连带登记父目录，
//     避免"授权 D:\models 顺带放行整个 D:\"。
//
//     需要注意：ALLOWED_SAVE_DIRS 的三根（userData / documents / desktop）对
//     isPathAllowed() 仍是递归开放的，但那是保存/读取的默认落点，删掉会直接
//     打断"另存为""打开工程"等主流程；这里能做的是不再让它继续扩散
//     （目录分支不再连带父目录）+ 三根之下的敏感子目录照样被 denylist 拦掉。
//
//   C. 文件分支（projectManager 传的是素材文件本身、MCP 传导出目标本身）
//     · 扩展名必须命中 AUTHORIZABLE_EXTENSIONS —— 工程、歌姬包、音频、
//       MIDI、LRC，覆盖打开工程与 MCP 导入/导出的全部素材类型；
//     · 已存在 → 放行（读取路径）；
//       不存在 → 只可能是导出目标（audio.exportTo / fragment.exportTo /
//       lrc.exportTo / project.saveTo），要求父目录已存在且非隐藏目录。
//       这样导出功能照常可用，但渲染进程无法在启动目录、~/.ssh 之类位置
//       预先"预定"一个 .exe/.dll 写入目标。
//
// 其余一切（含任意扩展名、任意新建目录）必须走原生对话框授权
// （dialog:showOpenDialog / dialog:showSaveDialog）。
const AUTHORIZABLE_EXTENSIONS = new Set([
  '.sxsproj', '.sxs', '.sxssinger', '.mid', '.midi',
  '.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.lrc',
]);

// 敏感目录 denylist —— 授权一个目录等于放行它下面的全部直接子文件，所以下列位置
// 必须显式拒绝，即使它们恰好落在 userData / documents / desktop 三根之下。
//
// 1) HOME_RELATIVE_SENSITIVE：相对用户主目录的固定子路径（跨平台）
//    · 凭据与密钥：~/.ssh、~/.aws、~/.gnupg、~/.kube、~/.docker
//    · 开机自启（Linux）：~/.config/autostart
//    · 密钥环（Linux）：~/.local/share/keyrings
//    · 钥匙串（macOS）：~/Library/Keychains（Cookie、已保存密码都在这里）
const HOME_RELATIVE_SENSITIVE = [
  ['.ssh'], ['.aws'], ['.gnupg'], ['.kube'], ['.docker'],
  ['.config', 'autostart'],
  ['.local', 'share', 'keyrings'],
  ['library', 'keychains'],
];

// 2) SENSITIVE_SEGMENT_PATTERNS：按"连续目录段序列"匹配，跨盘符/跨系统通用
//    · 开机自启（Windows）：...\Microsoft\Windows\Start Menu\Programs\Startup
//    · Windows 凭据管理器与 DPAPI 主密钥：Microsoft\Credentials / Protect / Crypto
//    · 浏览器 profile：Chrome / Edge / Firefox / Chromium / Brave 的用户数据目录
const SENSITIVE_SEGMENT_PATTERNS = [
  ['microsoft', 'windows', 'start menu'],
  ['microsoft', 'credentials'],
  ['microsoft', 'protect'],
  ['microsoft', 'crypto'],
  ['google', 'chrome', 'user data'],
  ['google', 'chrome sxs', 'user data'],
  ['microsoft', 'edge', 'user data'],
  ['mozilla', 'firefox', 'profiles'],
  ['bravesoftware', 'brave-browser', 'user data'],
  ['chromium', 'user data'],
  // macOS 钥匙串（也按段序列匹配一遍，避免依赖 homedir 解析结果）
  ['library', 'keychains'],
];

// 3) POSIX_SENSITIVE_PREFIXES：POSIX 上整棵系统树都不该被授权。
//    isSystemPath() 只覆盖了 /etc /root /sys /proc /dev /boot，这里补齐其余。
const POSIX_SENSITIVE_PREFIXES = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/var', '/run'];

// 是否含以 '.' 开头的目录段。首段为 POSIX 根（''）或 Windows 盘符，跳过。
function _hasHiddenComponent(resolvedPath) {
  const parts = resolvedPath.split(/[\\/]+/).filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].startsWith('.')) return true;
  }
  return false;
}

// 是否含 Windows 8.3 短名形态的段（SSH~1 / PROGRA~1 / MICROS~1 ...）。
// 这类段不以 '.' 开头，能绕过隐藏目录检查；形如 "名字前 6 位 + ~ + 数字"。
function _hasShortNameComponent(resolvedPath) {
  const parts = resolvedPath.split(/[\\/]+/).filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    if (/^[A-Z0-9]{1,6}~[0-9]/i.test(parts[i])) return true;
  }
  return false;
}

function _segments(resolvedPath) {
  return path.resolve(resolvedPath).split(/[\\/]+/).filter(Boolean);
}

function _startsWithSegments(segments, prefix) {
  if (segments.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (segments[i] !== prefix[i]) return false;
  }
  return true;
}

function _containsSegments(segments, pattern) {
  for (let i = 0; i + pattern.length <= segments.length; i++) {
    let hit = true;
    for (let j = 0; j < pattern.length; j++) {
      if (segments[i + j] !== pattern[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

function _isSensitiveDirectory(realPath) {
  const segments = _segments(realPath);
  const lower = segments.map(s => s.toLowerCase());
  try {
    const homeSegments = _segments(require('node:os').homedir()).map(s => s.toLowerCase());
    for (const relative of HOME_RELATIVE_SENSITIVE) {
      if (_startsWithSegments(lower, homeSegments.concat(relative))) return true;
    }
  } catch (_) { /* homedir 不可用时跳过这一组 */ }
  for (const pattern of SENSITIVE_SEGMENT_PATTERNS) {
    if (_containsSegments(lower, pattern)) return true;
  }
  if (process.platform !== 'win32') {
    const posixPath = '/' + lower.join('/');
    for (const prefix of POSIX_SENSITIVE_PREFIXES) {
      if (posixPath === prefix || posixPath.startsWith(prefix + '/')) return true;
    }
  }
  return false;
}

// 大小写不敏感的路径比较键（Windows 盘符大小写差异很常见）。
function _pathKey(p) {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// 大小写不敏感的前缀包含判断（Windows 路径大小写不敏感）。
function _isUnder(childPath, parentPath) {
  if (!parentPath || typeof parentPath !== 'string') return false;
  const normalize = p => {
    const n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? n.toLowerCase() : n;
  };
  const child = normalize(childPath);
  const parent = normalize(parentPath);
  return child === parent || child.startsWith(parent + '/');
}

// 目录内是否含有白名单扩展名的素材文件 —— 认定它是"素材/工程目录"的证据。
// 只扫前 500 项，避免在大目录上卡住主线程。
function _containsAuthorizableFile(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (let i = 0; i < entries.length && i < 500; i++) {
      if (!entries[i].isFile()) continue;
      if (AUTHORIZABLE_EXTENSIONS.has(path.extname(entries[i].name).toLowerCase())) return true;
    }
  } catch (_) { /* 读不了就当作没有证据 */ }
  return false;
}

// 目录分支的"登记目录"判定，四选一（详见文件头注释 B 段）。
function _isRegisteredDirectory(realPath) {
  for (const rootName of ['userData', 'documents', 'desktop']) {
    let root = null;
    try { root = app.getPath(rootName); } catch (_) { root = null; }
    if (root && _isUnder(realPath, root)) return true;
  }
  // 模型目录由用户自己在设置里挑，可能落在任意盘；它是主进程登记的位置，
  // 不是渲染进程随口指定的路径，因此单独放行（且只登记目录本身）。
  try {
    const modelDir = require('./modelDir').getModelDir();
    if (modelDir && _isUnder(realPath, modelDir)) return true;
  } catch (_) { /* modelDir 尚未就绪 */ }
  if (isAuthorizedAncestor(realPath)) return true;
  return _containsAuthorizableFile(realPath);
}

// 解析成真实路径：先对整体 realpathSync；失败（目标文件尚不存在）则退回
// "父目录 realpath + 末段"。两段都失败返回 null，调用方一律拒绝。
function _resolveRealPath(targetPath) {
  const resolved = path.resolve(targetPath);
  try {
    return { realPath: fs.realpathSync(resolved), existed: true };
  } catch (_) { /* 落到父目录分支 */ }
  try {
    const realParent = fs.realpathSync(path.dirname(resolved));
    return { realPath: path.join(realParent, path.basename(resolved)), existed: false };
  } catch (_) {
    return null;
  }
}

function registerDialogIpc() {
  safeHandle('dialog:showSaveDialog', async (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const safeOptions = {
      title: typeof options.title === 'string' ? options.title : undefined,
      defaultPath: typeof options.defaultPath === 'string' ? options.defaultPath : undefined,
      filters: Array.isArray(options.filters) ? options.filters : undefined,
    };
    const result = await dialog.showSaveDialog(win, safeOptions);
    if (!result.canceled && result.filePath) {
      authorizePath(result.filePath);
    }
    return result;
  });

  safeHandle('dialog:showOpenDialog', async (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const safeOptions = {
      title: typeof options.title === 'string' ? options.title : undefined,
      defaultPath: typeof options.defaultPath === 'string' ? options.defaultPath : undefined,
      filters: Array.isArray(options.filters) ? options.filters : undefined,
      properties: Array.isArray(options.properties) ? options.properties.filter(p =>
        ['openFile', 'openDirectory', 'multiSelections'].includes(p)
      ) : ['openFile'],
    };
    const result = await dialog.showOpenDialog(win, safeOptions);
    if (!result.canceled && result.filePaths) {
      result.filePaths.forEach(fp => authorizePath(fp));
    }
    return result;
  });

  // Atomic file save: write to a temp file in the same directory, then
  // rename over the target. A crash/power loss mid-write can no longer leave
  // a truncated .sxsproj. The previous version is kept as <file>.bak so the
  // user always has one fallback copy.
  safeHandle('file:saveFile', async (event, filePath, data) => {
    if (!isPathAllowed(filePath)) {
      return { success: false, error: t('error.pathNotAllowed') };
    }
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const bakPath = `${filePath}.bak`;
    try {
      await fs.promises.writeFile(tmpPath, data);
      // Move the current file to .bak (ENOENT on first save is fine), then
      // atomically replace the target with the temp file. If the final
      // rename fails, restore the backup so nothing is lost.
      let hadOriginal = false;
      try {
        await fs.promises.rename(filePath, bakPath);
        hadOriginal = true;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      try {
        await fs.promises.rename(tmpPath, filePath);
      } catch (err) {
        if (hadOriginal) {
          try { await fs.promises.rename(bakPath, filePath); } catch (_) {}
        }
        throw err;
      }
      return { success: true };
    } catch (err) {
      console.error('[Main] File save failed:', err.message);
      return { success: false, error: err.message };
    } finally {
      // Best-effort cleanup of a leftover temp file (rename already consumed
      // it on success; this only fires on earlier failures).
      fs.promises.unlink(tmpPath).catch(() => {});
    }
  });

  safeHandle('file:readFile', async (event, filePath) => {
    if (!isPathAllowed(filePath)) {
      throw new Error(t('error.pathNotAllowed'));
    }
    try {
      const data = await fs.promises.readFile(filePath, 'utf-8');
      return data;
    } catch (err) {
      console.error('[Main] File read failed:', err.message);
      throw err;
    }
  });

  safeHandle('file:readFileBuffer', async (event, filePath) => {
    if (!isPathAllowed(filePath)) {
      throw new Error(t('error.pathNotAllowed'));
    }
    try {
      const buffer = await fs.promises.readFile(filePath);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } catch (err) {
      console.error('[Main] File read (Buffer) failed:', err.message);
      throw err;
    }
  });

  safeHandle('file:exists', async (event, filePath) => {
    if (!isPathAllowed(filePath)) return false;
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      return true;
    } catch (_) {
      return false;
    }
  });

  safeHandle('file:authorizePath', async (event, dirPath) => {
    const { isSystemPath } = require('./security');
    if (typeof dirPath !== 'string' || dirPath.length === 0) {
      return { success: false, error: 'Invalid path' };
    }
    // 1. 先解析真实路径：符号链接（Documents/link → ~/.ssh）在这一步被还原成本体，
    //    后续所有判断与登记都用真实路径，杜绝"链接在白名单内、本体在外面"。
    const resolvedReal = _resolveRealPath(dirPath);
    if (!resolvedReal) {
      return { success: false, error: 'Path does not exist' };
    }
    const realPath = resolvedReal.realPath;
    // 渲染进程后续读写用的是它自己传进来的字符串。若该字符串只是真实路径的
    // 大小写/分隔符变体（Windows 盘符大小写很常见），就按它原样登记，避免
    // "授权成功但后续 isPathAllowed 因大小写不匹配而拒绝"；若两者不同
    // （说明中间有符号链接），只登记真实路径，绝不登记链接路径 —— 否则
    // 后续读取会顺着链接跑到白名单外面去。
    const requestedResolved = path.resolve(dirPath);
    const requestedIsSameFile = _pathKey(requestedResolved) === _pathKey(realPath);
    const authorizedPath = requestedIsSameFile ? requestedResolved : realPath;

    if (isSystemPath(realPath)) {
      return { success: false, error: 'Cannot authorize system directories' };
    }
    if (_isSensitiveDirectory(realPath)) {
      return { success: false, error: 'Cannot authorize sensitive directories' };
    }
    if (_hasHiddenComponent(realPath)) {
      return { success: false, error: 'Cannot authorize hidden directories' };
    }
    if (_hasShortNameComponent(realPath)) {
      // 8.3 短名（SSH~1 / PROGRA~1）不以 '.' 开头，专门用来绕过隐藏目录检查。
      return { success: false, error: 'Cannot authorize 8.3 short-name paths' };
    }

    let stats = null;
    try { stats = fs.statSync(realPath); } catch (_) { stats = null; }

    // 2. 目录分支：不再裸放行，必须是"登记的目录"（安全根之下 / 模型目录 /
    //    之前已授权 / 含白名单素材文件）。登记时只写目录本身，不连带父目录。
    if (stats && stats.isDirectory()) {
      if (!_isRegisteredDirectory(realPath)) {
        return { success: false, error: 'Directory is not a registered project or media directory' };
      }
      authorizePathExact(authorizedPath);
      return { success: true };
    }
    if (stats && !stats.isFile()) {
      return { success: false, error: 'Unsupported path type' };
    }
    // 3. 文件分支（stats 为 null = 目标文件尚不存在的导出目标）。
    // 扩展名必须命中白名单：工程、歌姬包、音频、MIDI、LRC。
    if (!AUTHORIZABLE_EXTENSIONS.has(path.extname(realPath).toLowerCase())) {
      return { success: false, error: 'Unsupported file type' };
    }
    if (!resolvedReal.existed) {
      // 目标文件尚不存在，只接受"父目录已存在"这一种情况，避免渲染进程
      // 在任意位置预先占位一个写入目标。父目录的真实性已在 _resolveRealPath
      // 里用 realpathSync 验证过。
      let dirStats = null;
      try { dirStats = fs.statSync(path.dirname(realPath)); } catch (_) { dirStats = null; }
      if (!dirStats || !dirStats.isDirectory()) {
        return { success: false, error: 'Target directory does not exist' };
      }
    }
    authorizePath(authorizedPath);
    return { success: true };
  });

  safeHandle('resolvePath', async (event, basePath, relativePath) => {
    const resolved = path.resolve(basePath, relativePath);
    const normalizedBase = path.resolve(basePath);
    if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
      throw new Error('Path traversal blocked');
    }
    return resolved;
  });

  safeHandle('getDirName', async (event, filePath) => {
    if (!isPathAllowed(filePath)) throw new Error(t('error.pathNotAllowed'));
    return path.dirname(filePath);
  });

  // 在系统文件管理器中显示指定文件（高亮选中该文件）
  // 用于导出完成后自动打开导出位置
  safeHandle('shell:showItemInFolder', async (event, filePath) => {
    try {
      const resolved = path.resolve(filePath);
      // Only reveal files under already-authorized paths. Previously this
      // branch auto-authorized any path, which let a compromised renderer
      // reveal arbitrary file-system locations (information leak / phishing).
      if (!isPathAllowed(resolved)) {
        return { success: false, error: t('error.pathNotAllowed') };
      }
      const fs = require('node:fs');
      if (fs.existsSync(resolved)) shell.showItemInFolder(resolved);
      else await shell.openPath(path.dirname(resolved));
      return { success: true };
    } catch (err) {
      console.error('[Main] showItemInFolder failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // 在系统默认浏览器中打开外部链接（设置 → 关于页面中的 arXiv / 项目主页等）。
  // 仅允许 https 且主机名命中白名单，防止被攻陷的渲染进程拉起任意 URI
  // （file://、smb://、钓鱼站点等）。主机名按"边界匹配"，避免
  // github.com.evil.com 之类的前缀绕过。
  safeHandle('shell:open-external', async (event, url) => {
    const ALLOWED_HOSTS = [
      'arxiv.org',
      'github.com',
      'huggingface.co',
      'basicpitch.io',
      'soul-ailab.github.io',
      'rosvot.github.io',
    ];
    if (!url || typeof url !== 'string') {
      return { success: false, error: 'Invalid URL' };
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return { success: false, error: 'Invalid URL' };
    }
    if (parsed.protocol !== 'https:') {
      return { success: false, error: 'Only https URLs are allowed' };
    }
    const host = parsed.hostname.toLowerCase();
    const allowed = ALLOWED_HOSTS.some(domain => host === domain || host.endsWith('.' + domain));
    if (!allowed) {
      return { success: false, error: 'Host not allowed' };
    }
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      console.error('[Main] openExternal failed:', err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerDialogIpc,
};
