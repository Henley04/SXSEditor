/**
 * 音频预处理窗口（歌手预处理）MIDI 编辑器的「新建音符」交互回归。
 *
 * 背景：这里原先只有双击才能新建音符，而分片编辑器是「按下左键拖动新建」。
 * 同一个产品里两个钢琴卷帘手感不一致，用户按分片编辑器的习惯在预处理窗口拖
 * 一下就什么都不会发生（反馈为"无法新建 MIDI"）。现在统一为按下即建、拖动
 * 决定时值，双击只保留"编辑歌词"。
 */

const assert = require('node:assert');

const BEAT_WIDTH = 80;
const HEADER_AND_F0 = 24 + 100; // HEADER_HEIGHT + F0_CURVE_AREA_HEIGHT

function buildDom() {
  document.body.innerHTML = `
    <div id="midi-container">
      <canvas id="midi-canvas"></canvas>
    </div>
    <span id="midi-info"></span>
    <div id="midi-hscroll"><div id="midi-hscroll-thumb"></div></div>
    <div id="midi-vscroll"><div id="midi-vscroll-thumb"></div></div>
  `;
  const container = document.getElementById('midi-container');
  const canvas = document.getElementById('midi-canvas');
  const rect = { left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400 };
  container.getBoundingClientRect = () => rect;
  canvas.getBoundingClientRect = () => rect;
  return canvas;
}

function mouse(canvas, type, x, y, extra = {}) {
  const ev = new window.MouseEvent(type, {
    clientX: x, clientY: y, bubbles: true, button: 0, ...extra,
  });
  (type === 'mouseup' ? document : canvas).dispatchEvent(ev);
  return ev;
}

describe('preprocess piano roll — drag to create notes', () => {
  let state;
  let initDomRefs;
  let initPianoRoll;

  before(async () => {
    // 渲染进程里 rAF 是全局的；jsdom 只提供 window.requestAnimationFrame。
    // 只在本文档内补齐，避免影响其它用例的时序假设。
    if (typeof global.requestAnimationFrame !== 'function') {
      global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
      global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
    }
    ({ state, initDomRefs } = await import('../src/audioPreprocess/state.js'));
    ({ initPianoRoll } = await import('../src/audioPreprocess/pianoRoll.js'));
  });

  beforeEach(async () => {
    if (state.pianoRoll && state.pianoRoll.destroy) state.pianoRoll.destroy();
    state.pianoRoll = null;
    const canvas = buildDom();
    initDomRefs();
    await initPianoRoll();
    state.pianoRoll.canvas = canvas;
  });

  after(() => {
    if (state.pianoRoll && state.pianoRoll.destroy) state.pianoRoll.destroy();
    state.pianoRoll = null;
  });

  it('空白处按下即新建音符（默认 1/4 拍），无需双击', () => {
    const pr = state.pianoRoll;
    const canvas = pr.canvas;
    assert.strictEqual(pr.notes.length, 0);

    mouse(canvas, 'mousedown', 300, 300);

    assert.strictEqual(pr.notes.length, 1, 'mousedown 就应该落一个音符');
    const note = pr.notes[0];
    assert.strictEqual(note.duration, Math.max(pr.snapGrid, 0.25));
    assert.strictEqual(note.lyric, 'la');
    assert.strictEqual(pr.dragMode, 'resize', '新建后应直接进入拖拽改时值状态');
    // 音高由点击的 y 换算，必须落在合法 MIDI 音高内
    assert.ok(note.pitch >= 0 && note.pitch <= 127, `音高越界: ${note.pitch}`);
    assert.ok(note.start >= 0);
  });

  it('按住拖动按拍长延长时值', () => {
    const pr = state.pianoRoll;
    const canvas = pr.canvas;

    mouse(canvas, 'mousedown', 300, 300);
    const created = pr.notes[0];
    const initial = created.duration;

    // 向右拖 2 拍（BEAT_WIDTH px = 1 拍，zoomX = 1）
    mouse(canvas, 'mousemove', 300 + BEAT_WIDTH * 2, 300);
    assert.strictEqual(created.duration, initial + 2, '拖 2 拍应加长 2 拍');

    mouse(canvas, 'mouseup', 300 + BEAT_WIDTH * 2, 300);
    assert.strictEqual(pr.dragMode, null);
    // 计数已刷新（locale 默认 en）
    assert.match(document.getElementById('midi-info').textContent, /1/);
  });

  it('拖动方向向左时不会短于吸附网格', () => {
    const pr = state.pianoRoll;
    const canvas = pr.canvas;

    mouse(canvas, 'mousedown', 400, 300);
    mouse(canvas, 'mousemove', 120, 300);
    const note = pr.notes[0];
    assert.ok(note.duration >= pr.snapGrid, `时值应 >= 网格 ${pr.snapGrid}，实际 ${note.duration}`);
    mouse(canvas, 'mouseup', 120, 300);
  });

  it('双击只编辑歌词，不会重复新建音符', () => {
    const pr = state.pianoRoll;
    const canvas = pr.canvas;

    // 双击空白：第一次 mousedown 建一个音符，双击本身不应再建第二个
    mouse(canvas, 'mousedown', 300, 300);
    mouse(canvas, 'mouseup', 300, 300);
    mouse(canvas, 'mousedown', 300, 300);
    mouse(canvas, 'mouseup', 300, 300);
    mouse(canvas, 'dblclick', 300, 300);

    assert.strictEqual(pr.notes.length, 1, '一次双击只应产生一个音符');
    // 双击命中的是刚建的音符 → 打开歌词内联编辑框
    assert.ok(state.activeInlineInput, '双击音符应打开歌词输入框');
    assert.strictEqual(state.activeInlineInput.value, 'la');
  });

  it('同音高重叠处按下不再新建音符', () => {
    const pr = state.pianoRoll;
    const canvas = pr.canvas;

    mouse(canvas, 'mousedown', 300, 300);
    mouse(canvas, 'mouseup', 300, 300);
    const note = pr.notes[0];
    assert.strictEqual(pr.notes.length, 1);

    // 点在音符起点左侧 2px：命中测试判为空白，但吸附后起拍与既有音符相同
    // （区间完全重叠），必须被重叠检测挡住。
    const x = pr._timeToX(note.start) - 2;
    const y = pr._pitchToY(note.pitch) + 4;
    assert.ok(y > HEADER_AND_F0);
    mouse(canvas, 'mousedown', x, y);

    assert.strictEqual(pr.notes.length, 1, '同音高重叠不应新建');
    mouse(canvas, 'mouseup', x, y);
  });

  it('拖拽加长时不会吃进同音高的下一个音符', () => {
    const pr = state.pianoRoll;
    const canvas = pr.canvas;

    // 手工铺两个同音高、间隔 1 拍的音符
    pr.notes.push(
      { id: 1, pitch: 60, start: 0, duration: 1, lyric: 'la' },
      { id: 2, pitch: 60, start: 2, duration: 1, lyric: 'la' },
    );
    pr._invalidateSortedNotes();

    const x0 = pr._timeToX(0) + 4;
    const y0 = pr._pitchToY(60) + 4;
    mouse(canvas, 'mousedown', x0, y0);
    assert.strictEqual(pr.selectedNoteId, 1);

    // 往右拖 5 拍：会撞上 id=2 的音符，长度必须停在它之前
    mouse(canvas, 'mousemove', x0 + BEAT_WIDTH * 5, y0);
    const first = pr.notes.find(n => n.id === 1);
    assert.ok(first.duration <= 2, `不应越过下一个音符起点 2，实际 ${first.duration}`);
    mouse(canvas, 'mouseup', x0 + BEAT_WIDTH * 5, y0);
  });
});
