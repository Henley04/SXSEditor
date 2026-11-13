/**
 * 「另存为」返回路径的归一化。
 *
 * 拆成独立模块而不是放进 projectManager：这里是纯字符串逻辑，没有 DOM、
 * IPC 与工程状态依赖，单测可以直接 require；projectManager 只在拿到原生
 * 对话框结果后调用一次。
 *
 * 两条规则各自对应一个用户能感知的失效：
 *   · 扩展名只看最后一段文件名 —— 目录名里的点（`C:\a.b\proj`）不能被
 *     `split('.').pop()` 当成扩展名分隔符，否则写出端会把 `b\proj` 当成格式；
 *   · 没有扩展名时补宿主默认格式 —— Linux/GTK 的原生保存框不会自动补后缀，
 *     用户也可能手动删掉后缀。这样的路径若直接交给写出端，会被误判为插件
 *     格式，最终报「没有插件能以该格式保存」，保存出的文件也打不开。
 */

/** 宿主自己解析的工程扩展名；与 projectManager.BUILTIN_PROJECT_EXTENSIONS 一致。 */
const BUILTIN_EXTENSIONS = ['sxsproj', 'sxs'];

/**
 * 取路径的扩展名（不含点、小写），没有扩展名时返回空串。
 *
 * 只看 basename；以点开头的隐藏文件（`.gitignore`）与以点结尾的名字
 * （`song.`）都视为没有扩展名。
 * @param {string} filePath
 * @returns {string}
 */
export function extensionOf(filePath) {
  const name = String(filePath || '').split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 另存为返回的路径若没有扩展名，补上宿主默认格式。
 *
 * 已有扩展名（包括 `.vpr` / `.svp` / `.vsqx` / `.sv2` 这些用户主动选择的
 * 外部格式）一律原样保留 —— 另存为允许导出到插件格式，不能替用户改写。
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeSavePath(filePath) {
  const value = String(filePath || '');
  if (!value || extensionOf(value)) return value;
  // 以点结尾的名字（song.）在 extensionOf 里同样算「无扩展名」，直接拼接会
  // 得到 song..sxsproj；先清掉尾点再补。若清完只剩目录分隔符，说明这不是
  // 文件名，原样交回，不替用户造隐藏文件。
  const base = value.replace(/\.+$/, '');
  if (!base || /[\\/]$/.test(base)) return value;
  return `${base}.sxsproj`;
}

/**
 * 目标是否为外部（插件）格式。
 * 无扩展名的路径经 normalizeSavePath 后已归为内置格式，这里不会误报。
 * @param {string} filePath
 * @returns {boolean}
 */
export function isExternalFormat(filePath) {
  const ext = extensionOf(filePath);
  return ext !== '' && !BUILTIN_EXTENSIONS.includes(ext);
}

/**
 * 内置插件能把伴奏音频写回容器里的外部格式。
 *
 * `official-project-import` 从 1.2.0 起会把伴奏重建为 VPR 的 `type: 1`
 * 音频轨，并把 WAV 字节写进 `Project/Audio/`。这份清单是宿主与随包内置插件
 * 之间的能力约定：插件新增可写回伴奏的格式时，这里必须同步，否则界面会对着
 * 一个明明能保留伴奏的格式弹出「伴奏将丢失」的误导性确认。
 */
const ACCOMPANIMENT_WRITEBACK_EXTS = new Set(['vpr']);

/**
 * 保存为该格式时伴奏音频会丢失，需要在写盘前提醒用户。
 * .sxsproj 是内置格式（本来就会内嵌音频），不在判定范围内。
 * @param {string} filePath
 * @returns {boolean}
 */
export function formatDropsAccompaniment(filePath) {
  return isExternalFormat(filePath) && !ACCOMPANIMENT_WRITEBACK_EXTS.has(extensionOf(filePath));
}

/**
 * 保存为该格式时必须把伴奏音频字节交给插件，否则无法写回。
 *
 * 插件不接触文件系统：只有 `embeddedAudioData.wavBase64` 能穿过 codec.write。
 * 因此即便用户在保存选项里取消勾选「嵌入伴奏音频」，写回这类容器时也要强制
 * 嵌入 —— 这不是覆盖用户偏好，而是格式本身的必要条件（对 .sxsproj 的偏好不变）。
 * @param {string} filePath
 * @returns {boolean}
 */
export function requiresAccompanimentAudio(filePath) {
  return ACCOMPANIMENT_WRITEBACK_EXTS.has(extensionOf(filePath));
}
