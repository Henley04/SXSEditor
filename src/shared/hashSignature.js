/**
 * 内容签名哈希 —— 「这份音频是用哪份输入算出来的」的唯一哈希算法。
 *
 * 三处消费方，必须逐字节一致：
 *   · 主进程合成缓存键（inference/pipeline/audioSegmentation.js 的 hashArray）
 *   · 主窗口播放缓存签名（renderer/audioSignature.js）
 *   · 分片编辑器预览签名（fragmentEditor/audioPlayback.js）
 *
 * 为什么必须共用：三处各自判断「输入没变，可以复用音频」。只要有一处把
 * 某个输入漏进/漏出签名，就会出现「改了一个音、播放还是老声音」这类
 * 只靠肉眼无法定位的问题。此前这份算法在两个文件里各写一遍，靠注释
 * 「⚠️ 两端必须同步修改」维系，且已经因此踩过坑（旧渲染层签名只采样
 * 4000 点、只取 byteLength，微调单点 pitch 会落在采样盲区里）。
 *
 * 采样规则（与历史实现逐位一致，勿改）：
 *   · 元素数 ≤ 2000：全量参与哈希；
 *   · 元素数 > 2000：按 floor(len / 2000) 步长采样，并**强制补上末元素**
 *     —— 编辑器的最后一个关键帧常落在尾部，漏掉它就会出现「改了没反应」；
 *   · 最后折叠进数组长度，使 [1,2] 与 [1,2,0] 不同。
 *
 * 数值一律以 float64 的 8 个字节参与哈希（而不是位运算截断成整数）：
 * 位运算会把 (-1, 1) 区间的浮点值全部塌成 0，F0 曲线的细微编辑因此无法改变
 * 签名，是历史上「音高改了但播放没变」的第二个根因。
 */

/**
 * 对数值数组做 FNV-1a 32-bit 哈希。
 *
 * 接受 Float32Array / Float64Array / Uint8Array / 普通数组；WAV 的字节缓冲
 * 也走这里（Uint8Array 元素按数值逐个展开，与非数组输入保持同一套规则）。
 *
 * @param {ArrayLike<number>|null|undefined} arr
 * @returns {number} 32-bit 有符号整数
 */
export function hashNumberArray(arr) {
  if (!arr) return 0;
  let h = 0x811c9dc5;
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  const hashValue = (value) => {
    view.setFloat64(0, Number.isFinite(Number(value)) ? Number(value) : 0, true);
    for (let j = 0; j < bytes.length; j++) {
      h ^= bytes[j];
      h = Math.imul(h, 0x01000193);
    }
  };
  const step = Math.max(1, Math.floor(arr.length / 2000));
  let lastHashed = -1;
  for (let i = 0; i < arr.length; i += step) {
    hashValue(arr[i]);
    lastHashed = i;
  }
  // 采样必须包含尾部：编辑器曲线的最后一个关键帧常落在尾部
  if (arr.length > 0 && lastHashed !== arr.length - 1) hashValue(arr[arr.length - 1]);
  hashValue(arr.length);
  return h | 0;
}

/**
 * 滚动多项式哈希（djb2 变体），用于把「字符串拼出来的字段」折成一个整数。
 *
 * 与 hashNumberArray 的分工：数组内容（F0 曲线、参考音频字节）走 FNV，
 * 结构化的短字段（音符序列、后端标识）先拼串再走本函数 —— 前者要抗
 * 采样盲区，后者要抗字段边界歧义（拼串里用分隔符，不依赖长度前缀）。
 *
 * @param {string} str
 * @param {number} [seed]
 * @returns {number} 32-bit 有符号整数
 */
export function hashString(str, seed = 0) {
  if (str === null || str === undefined) return seed | 0;
  const text = String(str);
  let h = seed | 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h;
}
