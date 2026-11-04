/**
 * 工程级渲染意图：把 `document.extSchema[*].render` 折成 pipeline 执行器要的形状。
 *
 * 为什么要有这一层
 * ----------------
 * `render: { hook: 'postWaveform', order: 20 }` 表达的是"**这份工程**的声音要靠
 * 这个插件的后处理"。但 pipeline 跑在主进程、工程文档在渲染层，中间没有别的
 * 通道能让这句话到达 hook 执行器 —— 于是每次打开工程后推一份"意图快照"过去。
 *
 * 为什么只推意图、不推数据
 * ----------------------
 * 推送要过 IPC，而 `ext` 可能有几 MB。执行器真正需要的只有两件事：哪个插件、
 * 什么顺序。曲线、音素那些是界面与编解码的事，和"跑不跑 hook"无关。
 *
 * @param {object|null} schema 已归一化的 extSchema
 * @returns {null|{[stage:string]: {[pluginId:string]: number}}} null 表示没有声明
 */
export function buildRenderIntent(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const out = {};
  for (const pluginId of Object.keys(schema)) {
    const entry = schema[pluginId];
    const render = entry && entry.render;
    if (!render || typeof render.hook !== 'string' || !render.hook) continue;
    const stage = render.hook;
    if (!out[stage]) out[stage] = {};
    // order 缺省 0：与 registry 的默认值一致，避免"没写 order"被排到最后
    out[stage][pluginId] = Number.isFinite(render.order) ? render.order : 0;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 意图里点名了、但当前没装的插件。
 *
 * 不阻断任何事，只用来提醒：用户打开一份工程，发现"这歌本该 -3dB 淡入"却没淡，
 * 至少能查到是缺插件，而不是以为文件坏了。
 *
 * @param {object|null} intent buildRenderIntent 的结果
 * @param {Set<string>|string[]} installedIds 已加载插件的 id
 * @returns {string[]}
 */
export function missingRenderPlugins(intent, installedIds) {
  if (!intent) return [];
  const have = installedIds instanceof Set ? installedIds : new Set(installedIds || []);
  const missing = new Set();
  for (const stage of Object.keys(intent)) {
    for (const pluginId of Object.keys(intent[stage])) {
      if (!have.has(pluginId)) missing.add(pluginId);
    }
  }
  return [...missing];
}
