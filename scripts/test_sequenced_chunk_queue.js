/**
 * SequencedChunkQueue 单元测试（零依赖，Node 直接运行）。
 *
 *   node scripts/test_sequenced_chunk_queue.js
 *
 * 用注入的虚拟定时器做确定性测试，覆盖：
 *   T1 顺序到达 → 立即消费
 *   T2 乱序到达 → 暂存，缺口补上后连续冲刷（sokuji _processBufferedSequences）
 *   T3 缺口超时 → 排序强制消费 + 跳跃前沿（sokuji _forceProcessBufferedSequences）
 *   T4 重复/过时 → 丢弃
 *   T5 重复 isLast → 仅透传标记，不重播音频
 *   T6 seek rebase → 丢弃目标前、保留目标后（moq parking playhead）
 *   T7 finish 排空
 *   T8 无采样区间 → 退化为到达顺序
 */
'use strict';

const SequencedChunkQueue = require('../src/shared/sequencedChunkQueue.js');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function eq(a, b, msg) { assert(a === b, `${msg} (got ${a}, want ${b})`); }

// ---- 虚拟定时器 ----
function makeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance: (ms) => {
      now += ms;
      // 反复触发所有到期定时器（处理定时器里再设定时器的情况）
      let again = true;
      while (again) {
        again = false;
        for (const [id, t] of Array.from(timers)) {
          if (t.at <= now) { timers.delete(id); t.fn(); again = true; }
        }
      }
    },
    pending: () => timers.size,
  };
}

function chunk(start, end, isLast = false) {
  return { sampleOffset: start, sampleEnd: end, audio: new Float32Array(end - start), isLast };
}

function makeQueue(clock, extra = {}) {
  const consumed = [];
  const q = new SequencedChunkQueue(Object.assign({
    gapTimeoutMs: 100,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onChunk: (c) => consumed.push(c),
  }, extra));
  return { q, consumed };
}

// ============ T1 顺序到达 ============
{
  const clock = makeClock();
  const { q, consumed } = makeQueue(clock);
  eq(q.push(chunk(0, 100)), 'consumed', 'T1 首块立即消费');
  eq(q.push(chunk(100, 200)), 'consumed', 'T1 连续块立即消费');
  eq(q.push(chunk(200, 300)), 'consumed', 'T1 连续块立即消费');
  eq(consumed.length, 3, 'T1 消费 3 块');
  eq(q.frontier, 300, 'T1 前沿=300');
}

// ============ T2 乱序到达 + 缺口补齐连续冲刷 ============
{
  const clock = makeClock();
  const { q, consumed } = makeQueue(clock);
  eq(q.push(chunk(0, 100)), 'consumed', 'T2 首块消费');
  eq(q.push(chunk(200, 300)), 'buffered', 'T2 超前块暂存');
  eq(q.push(chunk(100, 200)), 'consumed', 'T2 缺口补齐块消费');
  // 补上 100-200 后，缓冲里的 200-300 应被连续冲刷
  eq(consumed.length, 3, 'T2 连续冲刷后共消费 3 块');
  eq(consumed[1].sampleOffset, 100, 'T2 第2块 offset=100');
  eq(consumed[2].sampleOffset, 200, 'T2 第3块 offset=200（来自缓冲）');
  eq(q.frontier, 300, 'T2 前沿=300');
  eq(q.size, 0, 'T2 缓冲清空');
  eq(clock.pending(), 0, 'T2 gap 定时器已清除');
}

// ============ T3 缺口超时 → 排序强制消费 + 跳跃前沿 ============
{
  const clock = makeClock();
  const gaps = [];
  const { q, consumed } = makeQueue(clock, { onGap: (g) => gaps.push(g) });
  q.push(chunk(0, 100));        // 消费，前沿=100
  q.push(chunk(300, 400));      // 缺口 → 暂存
  q.push(chunk(200, 300));      // 仍超前（前沿=100）→ 暂存（乱序到达）
  eq(q.size, 2, 'T3 暂存 2 块');
  eq(clock.pending(), 1, 'T3 有 1 个 gap 定时器');
  clock.advance(101);           // 超时
  eq(gaps.length, 1, 'T3 触发 1 次 gap 诊断');
  eq(gaps[0].reason, 'timeout', 'T3 gap 原因=timeout');
  eq(q.size, 0, 'T3 缓冲清空');
  eq(consumed.length, 3, 'T3 强制消费全部 3 块');
  // 按 offset 排序：200 先于 300，即便 300 先到
  eq(consumed[1].sampleOffset, 200, 'T3 强制消费按 offset 排序（200 在前）');
  eq(consumed[2].sampleOffset, 300, 'T3 强制消费按 offset 排序（300 在后）');
  eq(q.frontier, 400, 'T3 跳跃式前沿=400');
}

// ============ T4 重复/过时 → 丢弃 ============
{
  const clock = makeClock();
  const dup = [];
  const { q, consumed } = makeQueue(clock, { onDuplicate: (c, r) => dup.push(r) });
  q.push(chunk(0, 100));
  q.push(chunk(100, 200));      // 前沿=200
  eq(q.push(chunk(50, 150)), 'duplicate', 'T4 过时块丢弃');
  eq(dup[0], 'stale', 'T4 丢弃原因=stale');
  eq(consumed.length, 2, 'T4 丢弃不计入消费');
  eq(q.push(chunk(100, 200)), 'duplicate', 'T4 重复块丢弃');
}

// ============ T5 重复 isLast → 仅透传标记 ============
{
  const clock = makeClock();
  const { q, consumed } = makeQueue(clock);
  q.push(chunk(0, 100));
  q.push(chunk(100, 200, true)); // isLast 已消费
  const dupLast = chunk(100, 200, true);
  q.push(dupLast);               // 重复 isLast
  const lastOnly = consumed.filter((c) => c.__lastOnly);
  eq(lastOnly.length, 1, 'T5 重复 isLast 透传一次标记');
  eq(lastOnly[0].audio.length, 0, 'T5 标记块音频为空（不重播）');
}

// ============ T6 seek rebase → parking playhead ============
{
  const clock = makeClock();
  const { q, consumed } = makeQueue(clock);
  q.push(chunk(0, 100));         // 消费，前沿=100
  q.push(chunk(200, 300));       // 暂存
  q.push(chunk(400, 500));       // 暂存（与上一块间有 100 采样缺口）
  eq(q.size, 2, 'T6 seek 前有 2 块缓冲');
  // seek 到缺口中间的 350：200-300 完全在目标前(end=300<=350)→丢弃；
  // 400-500 在目标后(end=500>350)→保留；其起点 400>350 不会被冲刷 → 留在缓冲
  q.rebase(350);
  eq(q.frontier, 350, 'T6 前沿重锚=350');
  eq(q.size, 1, 'T6 保留目标之后的块(400-500)');
  const remained = Array.from(q.buffer.keys());
  eq(remained[0], 400, 'T6 保留的是目标后的 400-500');

  // 再 seek 到 450：落在保留块内部 → 该块覆盖目标，被接续消费，前沿推进到 500
  q.rebase(450);
  eq(q.frontier, 500, 'T6 目标落在块内时接续消费到块尾 500');
  eq(q.size, 0, 'T6 缓冲清空');
  const last = consumed[consumed.length - 1];
  eq(last.sampleOffset, 400, 'T6 目标块(400-500)被接续消费');
}

// ============ T7 finish 排空 ============
{
  const clock = makeClock();
  const { q, consumed } = makeQueue(clock);
  q.push(chunk(0, 100));
  q.push(chunk(300, 400));       // 暂存
  q.finish();
  eq(q.isFinished, true, 'T7 finished 标志');
  eq(q.size, 0, 'T7 finish 排空缓冲');
  eq(consumed.length, 2, 'T7 finish 后消费全部');
  eq(q.frontier, 400, 'T7 finish 前沿=400');
}

// ============ T8 无采样区间 → 到达顺序 ============
{
  const clock = makeClock();
  const { q, consumed } = makeQueue(clock);
  q.push({ audio: new Float32Array(10) }); // 无 offset/end
  q.push({ audio: new Float32Array(20) });
  eq(consumed.length, 2, 'T8 无区间块按到达顺序消费');
  eq(q.frontier, 0, 'T8 前沿不推进');
}

// ============ 汇总 ============
console.log(`\nSequencedChunkQueue: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
