'use strict';
/**
 * 插件数据面：把"文件 → 插件 codec → 工程文档"这条链路收在一处。
 *
 * 为什么单独一个文件而不是塞进 PluginService：
 *   · 它需要同时读注册表（谁接管了这个扩展名）、权限（能不能读用户选的文件）、
 *     运行时（把字节送过去）与共享校验（文档合不合法），是典型的"编排"；
 *   · 这条链路有独立的失败模式（没有插件接管 / 没权限 / 文件太大 / 插件解码失败 /
 *     文档非法），集中在这里才能把每种失败讲清楚，而不是在 IPC 层拼错误字符串。
 *
 * 信任边界：插件产出的文档**必须**过 validateProjectDocument。它是跨进程克隆
 * 过来的第三方数据，直接交给 trackManager 等于把宿主的 state 交给插件写。
 */
const fs = require('node:fs');
const path = require('node:path');

const { TIMEOUTS, ERR } = require('../../shared/pluginApi.js');
const { validateProjectDocument } = require('../../shared/projectFormat.js');
const { writeFileAtomic } = require('../atomicWrite.js');
const store = require('./PluginStateStore.js');

/** 单次能打开的文件上限。工程文件远小于此；超过多半是选错了文件。 */
const MAX_OPEN_BYTES = 64 * 1024 * 1024;

/**
 * 单次能写出的字节上限。
 *
 * 比打开宽松得多：导出带嵌入素材的工程本来就可能很大。这里挡的是"插件算出了
 * 一个荒谬的 buffer"（比如把采样点数组当字节数组返回），不是正常工程。
 */
const MAX_WRITE_BYTES = 256 * 1024 * 1024;

/**
 * 双语文案。
 *
 * 这些 message 会经渲染层弹给用户看（`main.projectPluginOpenFailed` 的 {reason}），
 * 所以必须跟界面语言走。主进程拿得到 `getLocale()`，没有必要把整句的翻译放进
 * i18n 表 —— 每句只有两个版本，就地写清楚比在三个文件之间来回跳更好维护。
 */
function tr(zh, en) {
  let locale = 'zh-CN';
  try {
    locale = require('../locale').getLocale() || locale;
  } catch (_) { /* 未初始化时按中文 */ }
  return String(locale).toLowerCase().startsWith('zh') ? zh : en;
}

/** 文件类失败的错误码。渲染层按这些码给出不同的提示文案。 */
const FILE_ERR = Object.freeze({
  NOT_HANDLED: 'FILE_NOT_HANDLED',
  NOT_FOUND: 'FILE_NOT_FOUND',
  TOO_LARGE: 'FILE_TOO_LARGE',
  INVALID_DOCUMENT: 'INVALID_DOCUMENT',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  CANCELLED: 'CANCELLED',
});

/**
 * 把 codec.write 的返回值收敛成 Buffer。
 *
 * 四种形态都要认，因为插件作者很可能写出前三种里的任意一种：
 *   · Uint8Array / Buffer —— 正常路径（结构化克隆保持类型）
 *   · ArrayBuffer          —— `encodeWav()` 这类工具函数常返回它
 *   · string               —— 文本格式最自然的写法，宿主按 UTF-8 编码
 *   · number[]             —— 运行时若被 `safe()` 处理过就会退化成数组
 *
 * 最后一种不是"应该支持"，而是"不能让它在字节层面被静默解释错"：
 * `[1,2,3]` 被当作 UTF-8 处理会写出三个控制字符，看起来成功了，文件却废了。
 */
function toBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const n = raw[i];
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    }
    return Buffer.from(raw);
  }
  return null;
}

class PluginDataPlane {
  /**
   * @param {{service: object, registry: object, call: Function, logger?: object, locale?: Function}} deps
   *   call(pluginId, method, params, timeoutMs) —— 由 PluginService 注入，内部会按需拉起运行时
   */
  constructor(deps) {
    this.service = deps.service;
    this.registry = deps.registry;
    this.call = deps.call;
    this.logger = deps.logger || console;
    this.getLocale = typeof deps.locale === 'function' ? deps.locale : () => 'zh-CN';
  }

  /**
   * 某扩展名归属哪个插件。
   *
   * 只看 `loaded` 的插件：停用/隔离中的插件仍留在注册表里（为了管理器能显示它），
   * 但它的 codec 不该被调用 —— 那会让"我明明停用了它"变成一句空话。
   * 同扩展名被多个插件声明时按注册顺序取第一个（先装先得），其余在 listFileTypes
   * 里以 shadowed 标出，管理器可以提示作者改名。
   *
   * @param {string} ext
   * @param {{role?: 'open'|'save'}} [opts] 传 role 时只认能承担该角色的声明。
   *   打开不传：一个 `role:'save'` 的格式被命令行投递进来时，仍然应该路由到
   *   插件 —— 由它自己回 NOT_FOUND，比宿主猜"这大概不该打开"更准确。
   */
  resolve(ext, opts = {}) {
    const target = String(ext || '').toLowerCase();
    if (!target) return null;
    for (const entry of this.registry.list('fileType')) {
      if (entry.ext !== target) continue;
      if (opts.role && entry.role !== opts.role && entry.role !== 'both') continue;
      const record = this.registry.getPlugin(entry.pluginId);
      if (!record || record.status !== 'loaded') continue;
      return {
        pluginId: entry.pluginId,
        pluginName: record.manifest.name,
        ext: entry.ext,
        role: entry.role,
        label: entry.label || null,
        filters: entry.filters || [],
      };
    }
    return null;
  }

  /**
   * 全部可用的插件文件格式（按扩展名去重）。
   * @param {{role?: 'open'|'save'|'both'}} [options] 传 role 时只返回能承担该角色的格式
   */
  listFileTypes(options = {}) {
    const role = options.role;
    const byExt = new Map();
    for (const entry of this.registry.list('fileType')) {
      const record = this.registry.getPlugin(entry.pluginId);
      if (!record || record.status !== 'loaded') continue;
      if (role && entry.role !== role && entry.role !== 'both') continue;
      const row = {
        ext: entry.ext,
        role: entry.role,
        label: entry.label || null,
        filters: entry.filters || [],
        pluginId: entry.pluginId,
        pluginName: record.manifest.name,
      };
      const existing = byExt.get(entry.ext);
      if (!existing) {
        byExt.set(entry.ext, { ...row, shadowed: [] });
      } else {
        existing.shadowed.push({ pluginId: entry.pluginId, pluginName: record.manifest.name });
      }
    }
    return [...byExt.values()];
  }

  /**
   * 对话框过滤器。宿主自己的过滤器由调用方给，这里只产出插件那一部分 ——
   * 合并顺序（宿主格式在前）由调用方决定，插件不该把自己排到 .sxsproj 前面。
   *
   * @param {'open'|'save'} role
   * @param {(label: object|null, fallback: string) => string} pickLabel 本地化取值
   */
  fileFilters(role, pickLabel) {
    const pick = typeof pickLabel === 'function' ? pickLabel : (label, fallback) => fallback;
    return this.listFileTypes({ role }).map((ft) => ({
      name: pick(ft.label, `${ft.ext.slice(1).toUpperCase()} (${ft.pluginName})`),
      extensions: [ft.ext.slice(1)],
    }));
  }

  /**
   * 用插件打开一个文件，返回校验过的工程文档。
   *
   * 失败一律返回 `{ ok:false, code, message }` 而不是抛异常：调用方是 IPC handler，
   * 抛出会变成一个没有 code 的 500，渲染层分不清"没有插件接管"和"插件崩了"。
   *
   * @param {string} filePath
   * @returns {Promise<{ok:true, pluginId:string, ext:string, document:object, warnings:string[]}
   *                 | {ok:false, code:string, message:string, warnings?:string[]}>}
   */
  async openDocument(filePath) {
    if (typeof filePath !== 'string' || !filePath) {
      return { ok: false, code: ERR.INVALID_REQUEST, message: tr('缺少文件路径', 'Missing file path') };
    }
    const ext = path.extname(filePath).toLowerCase();
    const target = this.resolve(ext);
    if (!target) {
      return { ok: false, code: FILE_ERR.NOT_HANDLED, message: tr(`没有插件接管 ${ext || '该类型'} 文件`, `No plugin handles ${ext || 'this'} files`) };
    }

    const record = this.registry.getPlugin(target.pluginId);
    const perms = (record && record.manifest.permissions) || {};
    // 声明 fileTypes 只表示"我想接管"，读取用户选中的文件仍然要单独的 fs 权限。
    // 两者分开是有意的：接手格式是 UI 层面的声明，读盘是能力。
    if (!(perms.fs || []).includes('userPicked:read')) {
      return {
        ok: false,
        code: ERR.PERMISSION_DENIED,
        message: tr(`插件 ${target.pluginId} 缺少权限 fs:userPicked:read`, `Plugin ${target.pluginId} lacks the fs:userPicked:read permission`),
      };
    }

    let stat = null;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      return { ok: false, code: FILE_ERR.NOT_FOUND, message: tr(`文件不存在：${err.message}`, `File not found: ${err.message}`) };
    }
    if (!stat.isFile()) {
      return { ok: false, code: ERR.INVALID_REQUEST, message: tr('不是普通文件', 'Not a regular file') };
    }
    if (stat.size > MAX_OPEN_BYTES) {
      return {
        ok: false,
        code: FILE_ERR.TOO_LARGE,
        message: tr(
          `文件 ${Math.round(stat.size / 1024 / 1024)}MB 超过上限 ${MAX_OPEN_BYTES / 1024 / 1024}MB`,
          `File is ${Math.round(stat.size / 1024 / 1024)}MB, over the ${MAX_OPEN_BYTES / 1024 / 1024}MB limit`,
        ),
      };
    }

    // 白名单校验放在读盘之前：渲染层能通过对话框或 file:authorizePath 把路径
    // 登记进来，但不能凭一个字符串就让主进程读任意位置。扩展名路由只决定
    // "谁来解析"，不构成读盘授权。
    const { isPathAllowed } = require('../security');
    if (!isPathAllowed(filePath)) {
      return { ok: false, code: ERR.PERMISSION_DENIED, message: tr('路径未授权，请通过"打开"对话框选择文件', 'Path is not authorized; pick the file through the Open dialog') };
    }

    let bytes;
    try {
      bytes = await fs.promises.readFile(filePath);
    } catch (err) {
      return { ok: false, code: FILE_ERR.NOT_FOUND, message: tr(`读取失败：${err.message}`, `Read failed: ${err.message}`) };
    }

    let result;
    try {
      result = await this.call(
        target.pluginId,
        'codec.read',
        { ext, path: filePath, name: path.basename(filePath), size: stat.size, bytes },
        TIMEOUTS.command,
      );
    } catch (err) {
      store.audit('file-open', target.pluginId, { ext, ok: false, error: err && err.message });
      return {
        ok: false,
        code: (err && err.code) || ERR.INTERNAL,
        message: String((err && err.message) || err),
      };
    }

    if (!result || result.cancelled) {
      return { ok: false, code: FILE_ERR.CANCELLED, message: tr('插件取消了打开操作', 'The plugin cancelled the open operation') };
    }
    if (result.error) {
      store.audit('file-open', target.pluginId, { ext, ok: false, error: result.error });
      return {
        ok: false,
        code: ERR.INTERNAL,
        message: typeof result.error === 'string'
          ? result.error
          : (result.error.message || tr('插件返回了错误', 'The plugin returned an error')),
      };
    }

    const checked = validateProjectDocument(result.document);
    if (!checked.ok) {
      store.audit('file-open', target.pluginId, { ext, ok: false, error: checked.error });
      return {
        ok: false,
        code: FILE_ERR.INVALID_DOCUMENT,
        message: `${tr('工程文档不合法：', 'Invalid project document: ')}${checked.error}`,
        warnings: checked.warnings,
      };
    }

    store.audit('file-open', target.pluginId, {
      ext, ok: true, bytes: stat.size,
      singers: checked.document.singers.length,
      fragments: checked.document.fragments.length,
      warnings: checked.warnings.length,
    });
    return {
      ok: true,
      pluginId: target.pluginId,
      ext,
      document: checked.document,
      warnings: checked.warnings,
    };
  }

  /**
   * 把工程文档交给插件编码，再由宿主写盘。
   *
   * 为什么写盘留在宿主：插件进程没有文件系统权限。`userPicked:write` 的含义是
   * "允许宿主把这份文档交给插件编码、写到用户刚刚选的那个位置"，
   * 不是"插件可以自己 open/write"。这样"另存为"对话框仍然是唯一的写入授权来源。
   *
   * 文档在交给插件**之前**会再校验一遍：渲染层状态可能被 MCP 注入、被插件面板
   * 改坏，插件拿到的文档必须与打开时同构，否则 encode 出来的东西没人能保证。
   *
   * @param {string} filePath
   * @param {object} document
   * @param {{target?: 'save'|'export'}} [options]
   * @returns {Promise<{ok:true, pluginId:string, ext:string, bytes:number, warnings:string[]}
   *                 | {ok:false, code:string, message:string, warnings?:string[]}>}
   */
  async saveDocument(filePath, document, options = {}) {
    if (typeof filePath !== 'string' || !filePath) {
      return { ok: false, code: ERR.INVALID_REQUEST, message: tr('缺少保存路径', 'Missing save path') };
    }
    const ext = path.extname(filePath).toLowerCase();
    const target = this.resolve(ext, { role: 'save' });
    if (!target) {
      // 常见于用户把扩展名改成了"只声明 open"的格式。这不是失败，是能力边界 ——
      // 界面要能区分"没人管"与"有人读但没人写"。
      return {
        ok: false,
        code: FILE_ERR.NOT_HANDLED,
        message: tr(`没有插件能以 ${ext || '该'} 格式保存`, `No plugin can save ${ext || 'this'} format`),
      };
    }

    const record = this.registry.getPlugin(target.pluginId);
    const perms = (record && record.manifest.permissions) || {};
    if (!(perms.fs || []).includes('userPicked:write')) {
      return {
        ok: false,
        code: ERR.PERMISSION_DENIED,
        message: tr(
          `插件 ${target.pluginId} 缺少权限 fs:userPicked:write`,
          `Plugin ${target.pluginId} lacks the fs:userPicked:write permission`,
        ),
      };
    }

    const { isPathAllowed } = require('../security');
    if (!isPathAllowed(filePath)) {
      return {
        ok: false,
        code: ERR.PERMISSION_DENIED,
        message: tr('路径未授权，请通过"另存为"对话框选择位置', 'Path is not authorized; pick the location through the Save dialog'),
      };
    }

    const checked = validateProjectDocument(document);
    if (!checked.ok) {
      return {
        ok: false,
        code: FILE_ERR.INVALID_DOCUMENT,
        message: `${tr('工程文档不合法，未写入：', 'Invalid project document, nothing written: ')}${checked.error}`,
        warnings: checked.warnings,
      };
    }

    let result;
    try {
      result = await this.call(
        target.pluginId,
        'codec.write',
        {
          ext,
          path: filePath,
          name: path.basename(filePath),
          document: checked.document,
          target: options.target === 'export' ? 'export' : 'save',
        },
        TIMEOUTS.command,
      );
    } catch (err) {
      store.audit('file-save', target.pluginId, { ext, ok: false, error: err && err.message });
      return {
        ok: false,
        code: (err && err.code) || ERR.INTERNAL,
        message: String((err && err.message) || err),
      };
    }

    if (!result || result.cancelled) {
      return { ok: false, code: FILE_ERR.CANCELLED, message: tr('插件取消了保存操作', 'The plugin cancelled the save operation') };
    }
    if (result.error) {
      store.audit('file-save', target.pluginId, { ext, ok: false, error: result.error });
      return {
        ok: false,
        code: ERR.INTERNAL,
        message: typeof result.error === 'string'
          ? result.error
          : (result.error.message || tr('插件返回了错误', 'The plugin returned an error')),
      };
    }

    const bytes = toBuffer(result.bytes);
    if (!bytes) {
      store.audit('file-save', target.pluginId, { ext, ok: false, error: 'invalid output type' });
      return {
        ok: false,
        code: FILE_ERR.INVALID_OUTPUT,
        message: tr(
          '插件没有返回可写入的字节（需要 Uint8Array / ArrayBuffer / string）',
          'The plugin returned no writable bytes (expected Uint8Array / ArrayBuffer / string)',
        ),
      };
    }
    if (bytes.length > MAX_WRITE_BYTES) {
      return {
        ok: false,
        code: FILE_ERR.TOO_LARGE,
        message: tr(
          `插件产出 ${Math.round(bytes.length / 1024 / 1024)}MB，超过上限 ${MAX_WRITE_BYTES / 1024 / 1024}MB`,
          `The plugin produced ${Math.round(bytes.length / 1024 / 1024)}MB, over the ${MAX_WRITE_BYTES / 1024 / 1024}MB limit`,
        ),
      };
    }

    try {
      await writeFileAtomic(filePath, bytes);
    } catch (err) {
      store.audit('file-save', target.pluginId, { ext, ok: false, error: err.message });
      return { ok: false, code: ERR.INTERNAL, message: tr(`写入失败：${err.message}`, `Write failed: ${err.message}`) };
    }

    // 插件的告警（"3 个通道被量化"这类）必须往上传，否则用户永远不知道
    // 自己的编辑没有被完整写入。
    const warnings = Array.isArray(result.warnings)
      ? result.warnings.filter((w) => typeof w === 'string' && w).slice(0, 64)
      : [];

    store.audit('file-save', target.pluginId, {
      ext,
      ok: true,
      bytes: bytes.length,
      warnings: warnings.length,
      singers: checked.document.singers.length,
      fragments: checked.document.fragments.length,
    });
    return { ok: true, pluginId: target.pluginId, ext, bytes: bytes.length, warnings };
  }
}

module.exports = { PluginDataPlane, FILE_ERR, MAX_OPEN_BYTES, MAX_WRITE_BYTES };
