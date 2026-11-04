/**
 * 插件带来的音素 —— 从 `ext` 里取出、整理成宿主能画的样子。
 *
 * 为什么单独一层
 * --------------
 * 宿主的音素面板原本只有一种数据来源：`note.lyric` → 音素推导。这套推导
 * 只对宿主的音素表成立（`en_*` / `jp_*` / `zh_*` / `yue_*`）。而 SV2 / Vocaloid
 * 各有一套自己的符号表，同一个 `a` 在两家可能不是同一件事。把这些音素塞进
 * 宿主的推导结果里，等于用一个坐标系去解释另一个坐标系 —— 数值对得上，
 * 含义对不上。
 *
 * 所以插件音素是**并列的第二种视角**：宿主照自己的理解画（合成用它），
 * 同时把插件给的那一份灰着画出来（只读、不参与合成）。用户能对照看，
 * 但改不了 —— 宿主不知道 `["tS","a"]` 在你的引擎里合不合法。
 *
 * 这一层只做三件事：把 `ext` 里的值整理成 `{name, display}`、标出哪些名字
 * 属于宿主自己的命名空间、把规模裁到界面能承受的大小。它不认识任何具体
 * 方言，也不判断语义合法性。
 */

/** 单条 note 上最多显示几个外部音素；超出的截断并标记。 */
export const MAX_PHONEMES_PER_NOTE = 64;

/** 单个音素名的字符上限。引擎符号表里不会有更长的东西。 */
export const MAX_PHONEME_NAME = 32;

/**
 * 宿主自己的音素命名空间。
 *
 * 只用来决定"这个音素宿主认不认识"——认识的按普通灰显示，不认识的额外加
 * 虚线底纹。**不是合法性校验**：`en_ZZ9` 也匹配前缀，宿主照样不认识它。
 * 真要判断合法得拿到 phone_set，那份表在主进程的推理管线里，界面层不该为了
 * 一个视觉提示去拉 1200 条词表。
 */
const HOST_PREFIXES = ['en_', 'jp_', 'zh_', 'yue_'];

/** `<SP>` / `<AP>` 之类的控制符，宿主自己就在用。 */
const HOST_SPECIAL = /^<[A-Z][A-Z0-9_]*>$/;

/**
 * 这个音素名是否落在宿主自己的命名空间里。
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isHostPhonemeName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return false;
  if (HOST_SPECIAL.test(s)) return true;
  const lower = s.toLowerCase();
  for (const p of HOST_PREFIXES) {
    if (lower.startsWith(p) && s.length > p.length) return true;
  }
  return false;
}

function pushOne(out, raw) {
  let name;
  let display;
  if (typeof raw === 'string') {
    name = raw.trim();
    display = name;
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    // 插件可以带显示名（`{ name: 'tS', display: 'ch' }`）：符号名是给引擎的，
    // 显示名是给人看的。两个都留，界面优先画 display。
    name = String(raw.name == null ? '' : raw.name).trim();
    const d = String(raw.display == null ? '' : raw.display).trim();
    display = d || name;
  } else {
    return;
  }
  if (!name) return;
  if (name.length > MAX_PHONEME_NAME) name = name.slice(0, MAX_PHONEME_NAME);
  if (display.length > MAX_PHONEME_NAME * 2) display = display.slice(0, MAX_PHONEME_NAME * 2);
  // 重复音素不合并：它们是**序列**，`["a","a"]` 是两个音节。
  out.push({ name, display, host: isHostPhonemeName(name) });
}

/**
 * 把插件给的音素值整理成数组。
 *
 * 宽容接收三种常见形态，因为插件作者的第一反应各不相同：
 *   `["l", "a"]`
 *   `[{ name: "l", display: "l" }, ...]`
 *   `"l a"` / `"l,a"`
 *
 * @param {unknown} value
 * @returns {{phonemes: {name:string, display:string, host:boolean}[], truncated: boolean, dropped: number}}
 */
export function normalizePhonemeList(value) {
  const out = [];
  let truncated = false;
  let dropped = 0;

  let items;
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string') {
    items = value.split(/[\s,;|/]+/);
  } else {
    return { phonemes: out, truncated: false, dropped: 0 };
  }

  for (const raw of items) {
    if (out.length >= MAX_PHONEMES_PER_NOTE) { truncated = true; break; }
    const before = out.length;
    pushOne(out, raw);
    if (out.length === before) dropped++;
  }
  return { phonemes: out, truncated, dropped };
}

/**
 * 找出某一层"插件声明为音素"的字段，并整理成可绘制的形态。
 *
 * 与 `findField` 的区别：那个返回原始值（可能是字符串或对象数组），这个返回
 * 渲染层直接能用的数组。渲染层每帧都要调，所以结果要能缓存 —— 返回值里带上
 * `pluginId`，界面据此标注来源。
 *
 * @param {object} ext 该层的 ext
 * @param {object} schema document.extSchema
 * @param {'document'|'singer'|'fragment'|'note'} layer
 * @returns {{pluginId:string, field:string, editable:boolean, phonemes:object[], truncated:boolean}|null}
 */
export function readPhonemeField(ext, schema, layer = 'note') {
  if (!ext || typeof ext !== 'object') return null;
  for (const pluginId of Object.keys(ext)) {
    const entry = schema && schema[pluginId];
    const fields = entry && entry[layer];
    if (!fields) continue;
    for (const name of Object.keys(fields)) {
      const spec = fields[name];
      if (!spec || spec.kind !== 'phonemes') continue;
      const bag = ext[pluginId];
      const value = bag && typeof bag === 'object' ? bag[name] : undefined;
      if (value === undefined) continue;
      const { phonemes, truncated } = normalizePhonemeList(value);
      if (!phonemes.length) continue;
      return {
        pluginId,
        field: name,
        // 宿主一律只读呈现：`editable` 目前只影响界面提示语（"可编辑"还不支持，
        // 因为写回要经过插件的语义校验，宿主代劳会造出插件不认的值）。
        editable: spec.editable === true,
        phonemes,
        truncated,
      };
    }
  }
  return null;
}
