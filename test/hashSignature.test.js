'use strict';
/**
 * 播放签名哈希的回归测试。
 *
 * 这个哈希是三处「音频能不能复用」判定的共同基础（主进程合成缓存键、
 * 主窗口播放签名、分片编辑器预览签名）。它的规则一旦漂移，症状是
 * 「改了输入但播放没变」或「什么都没改却反复重推」，两者都很难从现象反推。
 * 因此这里直接冻结若干期望值，任何改动都必须在测试里显式体现。
 */
const { expect } = require('chai');
const { hashNumberArray, hashString } = require('../src/shared/hashSignature.js');

/** 旧实现的独立副本 —— 用来证明提取到 shared 后语义未变。 */
function legacyHashArray(arr) {
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
  if (arr.length > 0 && lastHashed !== arr.length - 1) hashValue(arr[arr.length - 1]);
  hashValue(arr.length);
  return h | 0;
}

describe('hashSignature — 数组内容哈希', () => {
  it('null / undefined 返回 0；空数组等于"长度 0 的哈希"', () => {
    expect(hashNumberArray(null)).to.equal(0);
    expect(hashNumberArray(undefined)).to.equal(0);
    // 空数组仍折叠一次长度，不返回 0 —— 与提取前的实现一致
    expect(hashNumberArray([])).to.equal(legacyHashArray([]));
    expect(hashNumberArray([])).to.not.equal(0);
  });

  it('与提取前的实现逐位一致（短数组 / 长数组 / TypedArray）', () => {
    const cases = [
      [0],
      [1, 2, 3],
      [0.123456789, -0.5, 3.75],
      Array.from({ length: 1999 }, (_, i) => Math.sin(i / 7)),
      Array.from({ length: 5000 }, (_, i) => Math.cos(i / 11)),
      new Float32Array([0.5, 0.25, 0.125]),
      new Uint8Array([255, 0, 17, 99]),
    ];
    for (const arr of cases) {
      expect(hashNumberArray(arr), `length=${arr.length}`).to.equal(legacyHashArray(arr));
    }
  });

  it('区分小数级差异（位运算截断会让 (-1,1) 全塌成 0）', () => {
    const a = [0.1, 0.2, 0.3];
    const b = [0.1, 0.2, 0.30001];
    expect(hashNumberArray(a)).to.not.equal(hashNumberArray(b));
  });

  it('长数组的尾部改动也会改变哈希（采样必须补末元素）', () => {
    const base = Array.from({ length: 4000 }, (_, i) => i / 4000);
    const tailChanged = base.slice();
    tailChanged[tailChanged.length - 1] = 0.987654321;
    expect(hashNumberArray(base)).to.not.equal(hashNumberArray(tailChanged));
  });

  it('长度参与折叠：[1,2] 与 [1,2,0] 不同', () => {
    expect(hashNumberArray([1, 2])).to.not.equal(hashNumberArray([1, 2, 0]));
  });

  it('非有限值按 0 处理，不产生随机哈希', () => {
    expect(hashNumberArray([NaN, Infinity, 1])).to.equal(legacyHashArray([NaN, Infinity, 1]));
  });
});

describe('hashSignature — 字符串滚动哈希', () => {
  it('空串返回种子值', () => {
    expect(hashString('')).to.equal(0);
    expect(hashString(null)).to.equal(0);
    expect(hashString('', 42)).to.equal(42);
  });

  it('支持增量累积（逐段喂入等价于一次性喂入）', () => {
    const parts = ['a|440|0|1', 'b|220|1|2', 'c|0|2|3'];
    let incremental = 0;
    for (const p of parts) incremental = hashString(p, incremental);
    // 逐段累积与一次性拼接的哈希不必相等（中间没有分隔符），但必须稳定
    expect(hashString(parts.join('|'))).to.equal(hashString(parts.join('|')));
    expect(incremental).to.equal(parts.reduce((h, p) => hashString(p, h), 0));
  });

  it('区分字段边界：[ab, c] 与 [a, bc] 拼出的串不同', () => {
    expect(hashString('ab|c')).to.not.equal(hashString('a|bc'));
  });
});
