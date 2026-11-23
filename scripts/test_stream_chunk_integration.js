/**
 * 流式 chunk 端到端集成测试（零依赖）：用真实 SequencedChunkQueue 模拟 IPC 乱序流。
 *
 *   node scripts/test_stream_chunk_integration.js
 *
 * 场景：模拟一段被 vocoder 切成 N 块的音频，chunk 带绝对 sampleOffset/sampleEnd。
 * 故意注入：乱序到达、重复块、过时块、一块彻底丢失（触发 gap 超时兜底）。
 * 验证：交付序列按 sampleOffset 严格有序、覆盖完整时间轴、无重复区间、前沿单调。
 */
'use strict';

const SequencedChunkQueue = require('../src/shared/sequencedChunkQueue.js');

const _SR = 24000;
const CHUNK = 2400; // 100ms/chunk
let passed = 0, failed = 0;
function assert(c, m) { if (c) passed++; else { failed++; console.error('  ✗ FAIL:', m); } }
function eq(a, b, m) { assert(a === b, `${m} (got ${a}, want ${b})`); }

function makeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance: (ms) => {
      now += ms; let again = true;
      while (again) { again = false;
        for (const [id, t] of Array.from(timers)) if (t.at <= now) { timers.delete(id); t.fn(); again = true; }
      }
    },
    pending: () => timers.size,
  };
}
function mk(start, n = CHUNK, isLast = false) {
  return { sampleOffset: start, sampleEnd: start + n, audio: new Float32Array(n), isLast };
}

// ============ 场景 1：乱序 + 重复 + 过时，无丢包 ============
{
  const clock = makeClock();
  const delivered = [];
  const q = new SequencedChunkQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onChunk: (c) => delivered.push(c),
  });
  // 6 块，正常顺序应为 0,2400,...,12000
  const blocks = [mk(0), mk(2400), mk(4800), mk(7200), mk(9600), mk(12000, CHUNK, true)];
  // 乱序到达：0, 4800, 2400(补齐), 7200, 4800(重复), 9600, 2400(过时), 12000(isLast)
  const arrival = [blocks[0], blocks[2], blocks[1], blocks[3], blocks[2], blocks[4], blocks[1], blocks[5]];
  arrival.forEach((b) => q.push(b));
  q.finish();
  const offs = delivered.map((c) => c.sampleOffset);
  eq(offs.join(','), '0,2400,4800,7200,9600,12000', 'S1 交付顺序严格有序且完整');
  eq(new Set(offs).size, offs.length, 'S1 无重复交付');
  eq(q.frontier, 14400, 'S1 前沿到达时间轴末端');
  eq(q.stats().duplicate, 2, 'S1 丢弃 2 个重复/过时块');
}

// ============ 场景 2：一块彻底丢失 → gap 超时兜底 → 继续播放 ============
{
  const clock = makeClock();
  const delivered = [];
  const gaps = [];
  const q = new SequencedChunkQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onChunk: (c) => delivered.push(c),
    onGap: (g) => gaps.push(g),
  });
  // 块 0,1 正常；块 2(4800) 丢失；块 3,4 到达后停留在缓冲；isLast 也到达
  q.push(mk(0));
  q.push(mk(2400));
  q.push(mk(7200));       // 缺口 4800
  q.push(mk(9600, CHUNK, true));
  eq(delivered.length, 2, 'S2 丢块后仅前 2 块交付');
  eq(q.size, 2, 'S2 后 2 块暂存');
  clock.advance(101);     // gap 超时
  eq(gaps.length, 1, 'S2 触发一次 gap 兜底');
  eq(delivered.length, 4, 'S2 超时后全部交付，播放继续（不永久静音）');
  const offs = delivered.map((c) => c.sampleOffset);
  eq(offs.join(','), '0,2400,7200,9600', 'S2 交付有序（缺失块客观跳过，其余连续）');
  eq(q.frontier, 12000, 'S2 跳跃式前沿=末块末端');
  eq(q.size, 0, 'S2 缓冲清空');
}

// ============ 场景 3：isLast 乱序先到不能提前收尾 ============
{
  const clock = makeClock();
  const delivered = [];
  const lastFlags = [];
  const q = new SequencedChunkQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onChunk: (c) => {
      delivered.push(c);
      if (c.isLast) lastFlags.push(c.sampleOffset);
    },
  });
  // isLast 块最先到达（网络/IPC 乱序），被暂存；前面的块后到
  q.push(mk(7200, CHUNK, true));
  q.push(mk(0));
  q.push(mk(2400));
  q.push(mk(4800));
  q.finish();
  const offs = delivered.map((c) => c.sampleOffset);
  eq(offs.join(','), '0,2400,4800,7200', 'S3 isLast 乱序仍在最后交付');
  eq(lastFlags.join(','), '7200', 'S3 isLast 标记只在末尾出现一次');
}

// ============ 场景 4：前沿单调性（随机乱序压力） ============
{
  const clock = makeClock();
  const delivered = [];
  const q = new SequencedChunkQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onChunk: (c) => delivered.push(c),
  });
  const N = 20;
  const blocks = Array.from({ length: N }, (_, i) => mk(i * CHUNK, CHUNK, i === N - 1));
  // 伪随机打乱到达顺序
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const shuffled = blocks.slice().sort(() => rand() - 0.5);
  shuffled.forEach((b) => q.push(b));
  q.finish();
  const offs = delivered.map((c) => c.sampleOffset);
  eq(offs.length, N, 'S4 全部块最终交付');
  let sorted = true;
  for (let i = 1; i < offs.length; i++) if (offs[i] < offs[i - 1]) sorted = false;
  assert(sorted, 'S4 交付采样位置单调不回退');
  eq(q.frontier, N * CHUNK, 'S4 前沿=全程末端');
}

console.log(`\nStream chunk integration: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
