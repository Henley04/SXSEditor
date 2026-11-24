'use strict';
/**
 * 分片拖拽收尾同步：拖拽期间的 updateFragmentBounds 被节流到 ~32ms，
 * 最后一帧可能停在中间值。用户拖出去又拖回原位（净变化为 0）时，
 * finishDrag 仍必须把精确边界补发一次，否则编辑器/主进程快照会停在中间位置。
 */

const { expect } = require('chai');
const sinon = require('sinon');

describe('finishDrag — 最终精确同步', function () {
  let state;
  let trackManager;
  let finishDrag;

  before(async function () {
    ({ state, trackManager } = await import('../src/renderer/state.js'));
    ({ finishDrag } = await import('../src/renderer/fragmentOperations.js'));
  });

  beforeEach(function () {
    trackManager.clearAll();
    state.dragState = null;
    state.fragmentDragSnapshot = null;
  });

  afterEach(function () {
    trackManager.clearAll();
    state.dragState = null;
    state.fragmentDragSnapshot = null;
  });

  it('净变化为 0 的拖拽仍会补发一次精确边界', function () {
    const singer = trackManager.addSinger({ name: 'S' });
    const fragment = trackManager.addFragment({
      singerId: singer.id,
      startTime: 4,
      duration: 2,
    });
    const updateFragmentBounds = sinon.spy();
    const originalAPI = window.electronAPI;
    window.electronAPI = { updateFragmentBounds };

    try {
      state.dragState = { type: 'move', fragment };
      // 拖拽期间最后一次 IPC 可能停在中间值；收尾时已拖回原位。
      state.fragmentDragSnapshot = {
        startTime: fragment.startTime,
        duration: fragment.duration,
        singerId: fragment.singerId,
      };

      finishDrag();

      expect(updateFragmentBounds.calledOnce).to.equal(true);
      expect(updateFragmentBounds.firstCall.args[0]).to.equal(fragment.id);
      expect(updateFragmentBounds.firstCall.args[1]).to.deep.equal({
        startTime: 4,
        duration: 2,
      });
      expect(state.dragState).to.equal(null);
      expect(state.fragmentDragSnapshot).to.equal(null);
    } finally {
      window.electronAPI = originalAPI;
    }
  });
});