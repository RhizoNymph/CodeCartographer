import { create } from "zustand";

interface LayoutDebugInfo {
  elkNodeIds: number;
  edgesInTree: number;
  edgesNotInTree: number;
  aggregatedEdges: number;
  elkEdgesInput: number;
  elkEdgesOutput: number;
  edgesWithSections: number;
  edgesWithoutSections: number;
  sampleGraphEdge: string;
  sampleElkNodeId: string;
  // Extra debug info
  codeBlocksInGraph: number;
  filesWithChildren: number;
  expandedFiles: number;
}

interface DebugState {
  layoutInfo: LayoutDebugInfo | null;
  logs: string[];
  setLayoutInfo: (info: LayoutDebugInfo) => void;
  addLog: (msg: string) => void;
}

export const useDebugStore = create<DebugState>((set) => ({
  layoutInfo: null,
  logs: [],
  setLayoutInfo: (info) => set({ layoutInfo: info }),
  addLog: (msg) => set((state) => ({
    logs: [...state.logs.slice(-9), `${new Date().toLocaleTimeString()}: ${msg}`]
  })),
}));
