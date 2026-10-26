/**
 * .sxsproj 格式版本与兼容性判定 —— 纯函数，供主窗口/CLI/MCP 共用。
 *
 * 背景（设计方案 §9）：版本号原先硬编码在两处（serializeProject 写 '1.1.0'、
 * loadProject 读 [1,1,0]），改一处忘另一处会把所有新工程误判成"版本过高/过低"。
 * 这里收敛成常量 + 单一判定函数，并补两个字段：
 *   · minReader —— "能正确读写该文件的最低版本"。低于它会**静默丢数据**
 *     （例如旧版不认识 auto 层，重存即丢），比单纯的 version 更能表达风险。
 *   · features  —— 能力清单。读到未知特性时提示但不阻断（前向兼容）。
 */

/** 当前写入的工程格式版本。新增可选字段 → minor+1；改语义/删字段 → major+1。 */
export const PROJECT_FORMAT_VERSION = '1.2.0';
export const PROJECT_FORMAT_PARTS = [1, 2, 0];

/** 低于此版本读写本文件会丢字段（autoPitchCurve 于 1.2.0 引入）。 */
export const PROJECT_MIN_READER = '1.2.0';

/** 本版本写入的能力清单。 */
export const PROJECT_FEATURES = ['autoPitchCurve'];

/** 解析 "1.2.0" → [1,2,0]；非法/空串返回 null。 */
export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const raw = v.trim();
  if (!raw) return null;
  const parts = raw.split('.').map((s) => Number(s));
  if (parts.length === 0 || parts.length > 3) return null;
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  while (parts.length < 3) parts.push(0);
  return parts;
}

/** a > b（逐段比较）。任一方非法返回 false。 */
export function isVersionGreater(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

/**
 * 判定一个工程头部的兼容性。
 *
 * @param {{version?:string, minReader?:string, features?:string[]}} obj
 * @param {string} [currentVersion]
 * @returns {{action:'ok'|'confirm'|'reject', reason:string, version:string,
 *            unknownFeatures:string[]}}
 *   · reject  —— major 更高，或 minReader 高于当前版本（会算错/丢数据）
 *   · confirm —— major 相同、minor 更高（旧代码会忽略新字段，重存即丢）
 *   · ok      —— 可正常加载（更低的版本走降级加载）
 */
export function checkProjectHeader(obj, currentVersion = PROJECT_FORMAT_VERSION) {
  const cur = parseVersion(currentVersion) || PROJECT_FORMAT_PARTS;
  const curStr = cur.join('.');
  const version = (obj && typeof obj.version === 'string') ? obj.version : '';
  const pv = parseVersion(version);

  const known = new Set(PROJECT_FEATURES);
  const unknownFeatures = Array.isArray(obj && obj.features)
    ? obj.features.filter((f) => typeof f === 'string' && !known.has(f))
    : [];

  if (!pv) {
    // 没有版本号 = 很旧的工程；按"降级加载"处理，不阻断
    return { action: 'ok', reason: 'no-version', version: version || '0.0.0', unknownFeatures };
  }

  // minReader 优先于 version：文件明确声明"低于它重存会丢数据"
  if (typeof obj.minReader === 'string' && isVersionGreater(obj.minReader, curStr)) {
    return { action: 'reject', reason: 'min-reader', version, unknownFeatures };
  }
  if (pv[0] > cur[0]) {
    return { action: 'reject', reason: 'major', version, unknownFeatures };
  }
  if (pv[0] === cur[0] && pv[1] > cur[1]) {
    return { action: 'confirm', reason: 'minor', version, unknownFeatures };
  }
  if (pv[0] < cur[0] || (pv[0] === cur[0] && pv[1] < cur[1])) {
    return { action: 'ok', reason: 'lower', version, unknownFeatures };
  }
  return { action: 'ok', reason: 'same', version, unknownFeatures };
}
