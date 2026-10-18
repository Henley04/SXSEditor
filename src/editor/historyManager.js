export class HistoryManager {
  constructor(maxSize = 200) {
    this.undoStack = [];
    this.redoStack = [];
    this.maxSize = maxSize;
    // Optional callback fired after a successful undo/redo. The main window
    // wires this to markDirty() so content changed via undo/redo can never
    // be lost by closing a "clean-looking" window.
    this.onMutation = null;
  }

  push(command) {
    this.undoStack.push(command);
    this.redoStack = [];
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return null;
    try {
      command.undo();
    } catch (err) {
      // 撤销失败：命令已经 pop 出 undoStack 又没进 redoStack，若不送回栈顶，
      // 这一步的撤销能力就永久丢失了（canUndo() 已经把它算掉）。
      // 这里**不要**清空 redoStack：撤销失败只是"这一步没能执行完"，用户此前
      // 通过 push() 之外的路径累积的重做能力（以及更早就存在的 redo 栈）与本次
      // 失败无关，清掉会让用户平白丢掉重做入口。命令回到 undoStack 后，
      // 状态仍是"这一步尚未撤销"，redoStack 里的未来状态依旧自洽。
      this.undoStack.push(command);
      throw err;
    }
    this.redoStack.push(command);
    if (this.onMutation) {
      try { this.onMutation('undo'); } catch (_) {}
    }
    return command;
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return null;
    try {
      command.redo();
    } catch (err) {
      // 与 undo() 对称：重做失败时命令必须回到 redoStack，否则该步永久丢失。
      this.redoStack.push(command);
      throw err;
    }
    this.undoStack.push(command);
    if (this.onMutation) {
      try { this.onMutation('redo'); } catch (_) {}
    }
    return command;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
