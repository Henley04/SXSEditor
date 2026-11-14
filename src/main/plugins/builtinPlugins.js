'use strict';
/**
 * 内置插件：随应用分发的官方插件，首次启动时自动安装到用户插件目录。
 *
 * 为什么要"安装"而不是直接从包内加载
 * ------------------------------------
 * 宿主的数据面、权限门、runtime 与注册表都以 `userData/plugins/<id>` 为唯一
 * 安装根：插件在那里才可写、才能被禁用/审计、才能生成 ext 与状态文件。app.asar
 * 是只读的，直接在包内运行会让这些机制全部落空。因此源码随包分发到
 * `.webpack/main/bundled-plugins/<id>/`，启动时复制一份到用户目录并走标准安装链路。
 *
 * 随包清单只有一份：src/shared/builtinPluginIds.js。打包拷贝（webpack）、启动安装
 * （本文件）、完整性守卫（test/copyWebpackClosure.test.js）都从那里取 id，避免
 * "包里有源码但没装"或"装了但打包没拷"这类只在全新安装机器上暴露的故障。
 *
 * 不覆盖原则：已经装过的用户目录一律不动 —— 但有一个例外：**内置来源的旧版本
 * 要升级**。内置插件随应用分发，旧版本里缺失的能力（例如 .svp 的 codec.write
 * 与 role:'both'、VPR/SVP 的伴奏写回）不会因为应用升级而自动出现；若坚持"永不覆盖"，
 * 老用户会永远停留在首次启动时装上的那份副本，表现为"能打开工程却无法保存"。
 * 因此仅当已装副本来源为 builtin、且包内版本更高时，才走标准安装链路覆盖升级。
 *
 * 用户自行安装的同名插件（来源非 builtin）、以及版本相同或更高的副本，仍一律
 * 不覆盖；升级也绝不把用户停用的插件重新启用。
 */
const fs = require('node:fs');
const path = require('node:path');

const installer = require('./PluginInstaller.js');
const store = require('./PluginStateStore.js');
const { SIGNATURE_STATUS } = require('../../shared/pluginSignature.js');
const { compareVersions } = require('../../shared/pluginMarket.js');
const { BUILTIN_PLUGIN_IDS } = require('../../shared/builtinPluginIds.js');

/** 兼容旧调用方：首个内置插件（官方工程导入）的 id。 */
const BUILTIN_ID = BUILTIN_PLUGIN_IDS[0];

/**
 * 定位包内某个内置插件的源码目录。
 *
 * 路径随运行形态变化：源码运行（npm start / 单元测试）时 plugins/<id>/ 在仓库根；
 * 打包运行时源码被 CopyPlugin 放到 `.webpack/main/bundled-plugins/<id>/`。用
 * `__dirname` 多候选 + `app.getAppPath()` 兜底，避免依赖某一种部署布局。
 *
 * 只认清单里的 id：随包目录被误放成别的插件时宁可不装，也不能把任意包以
 * builtin 来源悄悄塞进用户目录。
 *
 * @param {string} [id] 内置插件 id，缺省为首个（官方工程导入）
 * @returns {string|null}
 */
function resolveBuiltinPluginsDir(id = BUILTIN_ID) {
  if (!BUILTIN_PLUGIN_IDS.includes(id)) return null;
  const candidates = [
    // 打包后 main bundle 在 app.asar/.webpack/main/main/，本模块在 main/plugins/
    path.resolve(__dirname, '..', '..', 'bundled-plugins', id),
    path.resolve(__dirname, 'bundled-plugins', id),
    // 源码运行 / 测试：仓库根 plugins/
    path.resolve(__dirname, '..', '..', '..', 'plugins', id),
    path.resolve(process.cwd(), 'plugins', id),
  ];
  try {
    const app = require('electron').app;
    if (app && typeof app.getAppPath === 'function') {
      const root = app.getAppPath();
      candidates.push(path.join(root, '.webpack', 'main', 'bundled-plugins', id));
      candidates.push(path.join(root, 'plugins', id));
    }
  } catch (_) {
    // 非 Electron 环境（单元测试）忽略这一路，前面的候选已覆盖。
  }
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
    } catch (_) { /* 逐个探测 */ }
  }
  return null;
}

/** 读取已安装副本的清单版本；读不到或不是合法清单时返回 null。 */
function readInstalledVersion(dir) {
  try {
    const res = installer.readManifestFile(dir);
    return res.ok && res.value ? String(res.value.version || '') : null;
  } catch (_) {
    return null;
  }
}

/**
 * 确保**一个**内置插件已安装且为随包分发的版本。幂等：版本相同且目录完好时不写盘。
 *
 * 启动入口不直接调它，而是用 ensureAllBuiltinPlugins 遍历整份清单；保留单插件
 * 入口是为了让测试能把"某一版本的源码目录"注入进来复现升级场景。
 *
 * @param {object} [options]
 * @param {string} [options.id] 指定内置插件 id（缺省时按 sourceDir 的清单推断）
 * @param {string} [options.sourceDir] 覆盖内置源码目录（测试注入）
 * @param {string} [options.appVersion] 传入应用版本做清单兼容性校验
 * @returns {{ok:boolean, installed:boolean, id?:string, reason?:string, error?:string, upgraded?:boolean}}
 */
function ensureBuiltinPlugins(options = {}) {
  // 显式给 sourceDir 且没给 id 时，以该目录清单的 id 为准；否则按 id 去解析
  // 随包目录。两条路径最后都要过白名单，任意包都不会因为放在随包目录里就以
  // builtin 来源装进用户目录。
  const expectedId = options.id || (options.sourceDir ? null : BUILTIN_ID);
  const sourceDir = options.sourceDir || resolveBuiltinPluginsDir(expectedId || BUILTIN_ID);
  if (!sourceDir) {
    return {
      ok: false, installed: false, id: expectedId || BUILTIN_ID,
      reason: 'source-not-found', error: '内置插件源码目录未找到',
    };
  }

  const manifestRes = installer.readManifestFile(sourceDir);
  if (!manifestRes.ok || !manifestRes.value || !manifestRes.value.id) {
    return {
      ok: false, installed: false, id: expectedId || undefined,
      reason: 'invalid-manifest', error: manifestRes.error || '内置插件清单缺少 id',
    };
  }
  const id = manifestRes.value.id;
  // 只认清单里的内置插件，且与指定的 id 一致：随包目录被误放成别的插件时，
  // 宁可不装，也不能把任意包以 builtin 来源悄悄塞进用户目录。
  if (!BUILTIN_PLUGIN_IDS.includes(id) || (expectedId && id !== expectedId)) {
    return {
      ok: false, installed: false, id, reason: 'id-mismatch',
      error: `内置插件 id 与预期不一致：${id}${expectedId ? `（期望 ${expectedId}）` : ''}`,
    };
  }

  const p = store.ensureDirs();
  const targetDir = path.join(p.plugins, id);
  const registry = store.readRegistry();
  const recorded = !!((registry.plugins || {})[id]);
  const previousState = recorded ? store.getPluginState(registry, id) : null;
  const dirExists = fs.existsSync(path.join(targetDir, 'manifest.json'));

  // 注册表有记录且目录还在时，默认不覆盖 —— 不覆盖用户的选择是内置策略的底线。
  // 唯一的例外是"随包版本更新"：内置插件的能力（例如 .svp 的 codec.write 与
  // role:'both'）只会随应用升级出现，旧副本不会自己长出这些能力。仅当四个条件
  // 同时成立才升级：已登记、目录完好、来源是 builtin、包内版本严格更高。
  //
  // 版本必须读用户目录的 manifest：registry 的 getPluginState 不返回 version。
  // compareVersions 在任一版本非法时返回 null，按"无法比较"处理 —— 宁可不升级，
  // 也不能因为一份坏清单覆盖用户目录。非 builtin 来源（用户自行安装的同名插件）
  // 即使版本更低也绝不升级。
  const bundledVersion = String(manifestRes.value.version || '');
  const installedVersion = dirExists ? readInstalledVersion(targetDir) : null;
  const comparison = installedVersion === null ? null : compareVersions(bundledVersion, installedVersion);
  const needsUpgrade = recorded && dirExists
    && previousState && previousState.source === 'builtin'
    && comparison !== null && comparison > 0;

  if (recorded && dirExists && !needsUpgrade) {
    return { ok: true, installed: false, id, reason: 'already-installed' };
  }

  // app.asar 只读：installFromDirectory 会 moveDir 源目录，这里先复制到
  // 可写的暂存目录，再由安装器搬进用户插件目录。
  let staging;
  try {
    staging = fs.mkdtempSync(path.join(p.staging, `builtin-${id}-`));
    const stagedSource = path.join(staging, id);
    fs.cpSync(sourceDir, stagedSource, { recursive: true });

    const result = installer.installFromDirectory(stagedSource, {
      dirName: id,
      source: 'builtin',
      appVersion: options.appVersion,
      // 随应用分发、没有独立的插件签名文件：如实记为未签名 + 内置来源，
      // 不谎称"验签通过"。管理器会为内置插件单独显示来源标签。
      signature: {
        status: SIGNATURE_STATUS.UNSIGNED,
        origin: 'builtin',
        publisher: 'SXSEditor Official',
        verifiedAt: Date.now(),
      },
    });
    if (!result.ok) {
      return { ok: false, installed: false, id, error: result.error };
    }
    // 安装器每次都会写 enabled:true 并重置签名与安装时间。目录被删后的重装、
    // 以及按版本升级，都必须把用户此前的状态还原 —— 否则一次升级就把"停用"
    // 悄悄改回启用，用户的插件设置和签名历史也会凭空消失。
    // permissionsHash 属于新清单，不还原；quarantine/crash 计数由安装器清零，
    // 那是运行期事实，不该从上一版本继承。
    if (previousState) {
      const current = store.readRegistry();
      store.setPluginState(current, id, {
        enabled: previousState.enabled,
        settings: previousState.settings,
        signature: previousState.signature,
        installedAt: previousState.installedAt,
        keybindingsEnabled: previousState.keybindingsEnabled,
        automationExpose: previousState.automationExpose,
      });
      store.writeRegistry(current);
    }
    // 安装器内部已经按 source='builtin' 写过 install 审计，这里不重复留痕；
    // 升级额外补一条带 from/to 的记录，便于日后追溯"这次升级替换了哪一份副本"。
    if (needsUpgrade) {
      store.audit('upgrade', id, {
        from: installedVersion,
        to: result.version,
        source: 'builtin',
      });
    }
    return { ok: true, installed: true, id, version: result.version, upgraded: needsUpgrade };
  } catch (err) {
    return { ok: false, installed: false, id, error: String((err && err.message) || err) };
  } finally {
    if (staging) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响安装结果 */ }
    }
  }
}

/**
 * 逐个确保整份清单里的内置插件都已安装且为随包版本。
 *
 * 为什么不透传 sourceDir：批量入口面向真实启动，每个 id 必须各自解析自己的随包
 * 目录；共用一个目录会让所有 id 装成同一份源码。测试要注入特定版本时用单插件
 * 入口 ensureBuiltinPlugins。
 *
 * 为什么逐个 try：一个插件的源码缺失或清单损坏，最多是那一种格式打不开，不能让
 * 排在它后面的内置插件一起缺席，更不能把应用启动拖挂。
 *
 * @param {object} [options]
 * @param {string} [options.appVersion] 应用版本，用于清单兼容性校验
 * @returns {{ok:boolean, installed:boolean, upgraded:boolean, results:Array<object>}}
 */
function ensureAllBuiltinPlugins(options = {}) {
  const results = BUILTIN_PLUGIN_IDS.map((id) => {
    try {
      return ensureBuiltinPlugins({ id, appVersion: options.appVersion });
    } catch (err) {
      return { ok: false, installed: false, id, error: String((err && err.message) || err) };
    }
  });
  return {
    ok: results.every((r) => r.ok),
    installed: results.some((r) => r.installed),
    upgraded: results.some((r) => r.upgraded),
    results,
  };
}

/**
 * 启动入口：主进程在初始化插件服务之前调用一次。
 *
 * 为什么把日志与异常兜底放在这里、而不是让每个调用点各写一遍：内置插件装不上
 * 最多是打不开外部工程，绝不该把应用启动拖挂。源码目录没随包分发是精简构建的
 * 合法降级，只记一行说明、不按错误刷屏；其它失败才 warn。
 *
 * @param {string} [appVersion] 应用版本，用于清单兼容性校验
 * @returns {{ok:boolean, installed:boolean, upgraded?:boolean, results:Array<object>, error?:string}}
 */
function installBuiltinOnStartup(appVersion) {
  try {
    const summary = ensureAllBuiltinPlugins({ appVersion });
    for (const result of summary.results) {
      const id = result.id || '?';
      if (result.ok && result.upgraded) {
        console.log(`[plugins] 内置插件已升级：${id}@${result.version || ''}`);
      } else if (result.ok && result.installed) {
        console.log(`[plugins] 内置插件已安装：${id}@${result.version || ''}`);
      } else if (result.ok) {
        // already-installed：用户可能已停用或自行装过，保持原样。
        console.log(`[plugins] 内置插件已存在，未覆盖：${id}`);
      } else if (result.reason === 'source-not-found') {
        console.log(`[plugins] 未随包分发内置插件源码，跳过：${id}`);
      } else {
        console.warn(`[plugins] 内置插件 ${id} 安装失败：${result.error || result.reason}`);
      }
    }
    return summary;
  } catch (err) {
    console.warn('[plugins] 内置插件安装异常：', (err && err.message) || err);
    return { ok: false, installed: false, results: [], error: String((err && err.message) || err) };
  }
}

module.exports = {
  BUILTIN_ID,
  BUILTIN_PLUGIN_IDS,
  resolveBuiltinPluginsDir,
  ensureBuiltinPlugins,
  ensureAllBuiltinPlugins,
  installBuiltinOnStartup,
};
