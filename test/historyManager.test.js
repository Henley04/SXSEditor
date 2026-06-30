const { expect } = require('chai');
const { HistoryManager } = require('../src/editor/historyManager');

function makeCommand(undoCalls, redoCalls, label) {
  return {
    label,
    undo: () => { undoCalls.push(label); },
    redo: () => { redoCalls.push(label); },
  };
}

describe('editor/historyManager', () => {
  let undoCalls, redoCalls;
  beforeEach(() => {
    undoCalls = [];
    redoCalls = [];
  });

  it('should start with empty stacks', () => {
    const h = new HistoryManager();
    expect(h.canUndo()).to.be.false;
    expect(h.canRedo()).to.be.false;
  });

  it('canUndo after push, canRedo after undo', () => {
    const h = new HistoryManager();
    h.push(makeCommand(undoCalls, redoCalls, 'a'));
    expect(h.canUndo()).to.be.true;
    expect(h.canRedo()).to.be.false;
    h.undo();
    expect(h.canUndo()).to.be.false;
    expect(h.canRedo()).to.be.true;
  });

  it('undo should call command.undo and push to redo stack', () => {
    const h = new HistoryManager();
    h.push(makeCommand(undoCalls, redoCalls, 'a'));
    const result = h.undo();
    expect(undoCalls).to.deep.equal(['a']);
    expect(result).to.not.be.null;
    expect(result.label).to.equal('a');
  });

  it('redo should call command.redo and push back to undo stack', () => {
    const h = new HistoryManager();
    h.push(makeCommand(undoCalls, redoCalls, 'a'));
    h.undo();
    const result = h.redo();
    expect(redoCalls).to.deep.equal(['a']);
    expect(result).to.not.be.null;
    expect(h.canUndo()).to.be.true;
    expect(h.canRedo()).to.be.false;
  });

  it('undo on empty stack returns null and does nothing', () => {
    const h = new HistoryManager();
    const result = h.undo();
    expect(result).to.be.null;
    expect(undoCalls).to.deep.equal([]);
  });

  it('redo on empty stack returns null and does nothing', () => {
    const h = new HistoryManager();
    const result = h.redo();
    expect(result).to.be.null;
    expect(redoCalls).to.deep.equal([]);
  });

  it('push should clear the redo stack (no redo after new action)', () => {
    const h = new HistoryManager();
    h.push(makeCommand(undoCalls, redoCalls, 'a'));
    h.undo();
    expect(h.canRedo()).to.be.true;
    h.push(makeCommand(undoCalls, redoCalls, 'b'));
    expect(h.canRedo()).to.be.false;
  });

  it('should respect maxSize and drop oldest', () => {
    const h = new HistoryManager(3);
    h.push(makeCommand(undoCalls, redoCalls, 'a'));
    h.push(makeCommand(undoCalls, redoCalls, 'b'));
    h.push(makeCommand(undoCalls, redoCalls, 'c'));
    h.push(makeCommand(undoCalls, redoCalls, 'd'));
    // oldest 'a' dropped
    h.undo(); // d
    h.undo(); // c
    h.undo(); // b
    expect(undoCalls).to.deep.equal(['d', 'c', 'b']);
    expect(h.canUndo()).to.be.false;
  });

  it('clear should empty both stacks', () => {
    const h = new HistoryManager();
    h.push(makeCommand(undoCalls, redoCalls, 'a'));
    h.push(makeCommand(undoCalls, redoCalls, 'b'));
    h.undo();
    h.clear();
    expect(h.canUndo()).to.be.false;
    expect(h.canRedo()).to.be.false;
  });

  it('should handle a full undo/redo sequence in correct order', () => {
    const h = new HistoryManager();
    h.push(makeCommand(undoCalls, redoCalls, 'a'));
    h.push(makeCommand(undoCalls, redoCalls, 'b'));
    h.push(makeCommand(undoCalls, redoCalls, 'c'));
    h.undo(); // c
    h.undo(); // b
    h.redo(); // b
    h.undo(); // b
    expect(undoCalls).to.deep.equal(['c', 'b', 'b']);
    expect(redoCalls).to.deep.equal(['b']);
  });

  it('should use default maxSize of 200', () => {
    const h = new HistoryManager();
    expect(h.maxSize).to.equal(200);
  });

  it('should accept custom maxSize', () => {
    const h = new HistoryManager(50);
    expect(h.maxSize).to.equal(50);
  });

  it('should not overflow when pushing exactly maxSize commands', () => {
    const h = new HistoryManager(5);
    for (let i = 0; i < 5; i++) {
      h.push(makeCommand(undoCalls, redoCalls, 'c' + i));
    }
    expect(h.undoStack.length).to.equal(5);
    h.push(makeCommand(undoCalls, redoCalls, 'overflow'));
    expect(h.undoStack.length).to.equal(5);
  });
});
