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
    if (command) {
      command.undo();
      this.redoStack.push(command);
      if (this.onMutation) {
        try { this.onMutation('undo'); } catch (_) {}
      }
    }
    return command || null;
  }

  redo() {
    const command = this.redoStack.pop();
    if (command) {
      command.redo();
      this.undoStack.push(command);
      if (this.onMutation) {
        try { this.onMutation('redo'); } catch (_) {}
      }
    }
    return command || null;
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
