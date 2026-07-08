import { create } from "zustand";
import type { EdgeKind } from "../api/types";

export interface Snapshot {
  visibleNodes: Set<string>;
  expandedNodes: Set<string>;
  enabledEdgeKinds: Set<EdgeKind>;
  hideUnconnectedNodes: boolean;
}

const MAX_HISTORY = 50;

interface HistoryState {
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  canUndo: boolean;
  canRedo: boolean;
  pushSnapshot: (snapshot: Snapshot) => void;
  undo: (current: Snapshot) => Snapshot | null;
  redo: (current: Snapshot) => Snapshot | null;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,

  pushSnapshot: (snapshot) => {
    const { undoStack } = get();
    const newStack = [...undoStack, snapshot];
    if (newStack.length > MAX_HISTORY) {
      newStack.shift();
    }
    set({
      undoStack: newStack,
      redoStack: [],
      canUndo: true,
      canRedo: false,
    });
  },

  undo: (current) => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) return null;

    const snapshot = undoStack[undoStack.length - 1];
    const newUndoStack = undoStack.slice(0, -1);
    set({
      undoStack: newUndoStack,
      redoStack: [...redoStack, current],
      canUndo: newUndoStack.length > 0,
      canRedo: true,
    });
    return snapshot;
  },

  redo: (current) => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) return null;

    const snapshot = redoStack[redoStack.length - 1];
    const newRedoStack = redoStack.slice(0, -1);
    set({
      undoStack: [...undoStack, current],
      redoStack: newRedoStack,
      canUndo: true,
      canRedo: newRedoStack.length > 0,
    });
    return snapshot;
  },

  clear: () => {
    set({
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });
  },
}));
