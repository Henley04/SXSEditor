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
const store = require('./PluginStateStore.js');

/** 单次能打开的文件上限。工程文件远小于此；超过多半是选错了文件。 */
const MAX_OPEN_BYTES = 64 * 1024 * 1024;

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
  CANCELLED: 'CANCELLED',
});

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
   */
  resolve(ext) {
    const target = String(ext || '').toLowerCase();
    if (!target) return null;
    for (const entry of this.registry.list('fileType')) {
      if (entry.ext !== target) continue;
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
}

module.exports = { PluginDataPlane, FILE_ERR, MAX_OPEN_BYTES };
