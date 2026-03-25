import { create } from "zustand";
import type { CodeGraph, CodeNode, EdgeKind, ParseEvent } from "../api/types";
import { saveFolderState, loadFolderState } from "./persistenceStore";
import { useDebugStore } from "./debugStore";

interface ParseProgress {
  totalFiles: number;
  parsedFiles: number;
  totalBlocks: number;
  currentFile: string;
  errors: Array<{ path: string; message: string }>;
}

interface GraphState {
  // Source path
  repoPath: string | null;

  // The full code graph from backend
  graph: CodeGraph | null;

  // Parsing state
  isParsing: boolean;
  parseProgress: ParseProgress | null;

  // Visibility state
  expandedNodes: Set<string>;
  visibleNodes: Set<string>;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;

  // Edge filter state
  enabledEdgeKinds: Set<EdgeKind>;

  // Layout state - manual relayout
  needsRelayout: boolean;
  layoutVersion: number; // Incremented when relayout should happen

  // Actions
  setRepoPath: (path: string) => void;
  setGraph: (graph: CodeGraph, restoreState?: boolean) => void;
  setIsParsing: (v: boolean) => void;
  handleParseEvent: (event: ParseEvent) => void;
  toggleExpanded: (nodeId: string) => void;
  setExpanded: (nodeId: string, expanded: boolean) => void;
  toggleVisible: (nodeId: string) => void;
  setSelectedNode: (nodeId: string | null) => void;
  setHoveredNode: (nodeId: string | null) => void;
  toggleEdgeKind: (kind: EdgeKind) => void;
  getVisibleNodeIds: () => string[];
  requestRelayout: () => void;
  saveCurrentState: () => void;
}

const ALL_EDGE_KINDS: EdgeKind[] = [
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
];

export const useGraphStore = create<GraphState>((set, get) => ({
  repoPath: null,
  graph: null,
  isParsing: false,
  parseProgress: null,
  expandedNodes: new Set<string>(),
  visibleNodes: new Set<string>(),
  selectedNodeId: null,
  hoveredNodeId: null,
  enabledEdgeKinds: new Set<EdgeKind>(ALL_EDGE_KINDS),
  needsRelayout: false,
  layoutVersion: 0,

  setRepoPath: (path) => set({ repoPath: path }),

  setGraph: (graph, restoreState = true) => {
    const repoPath = get().repoPath;
    let expanded = new Set<string>();
    let visible = new Set<string>();

    if (graph) {
      // Try to restore saved state for this folder
      let restored = false;
      if (restoreState && repoPath) {
        const saved = loadFolderState(repoPath);
        if (saved) {
          // Filter to only include nodes that still exist in the graph
          const validExpanded = saved.expandedNodes.filter(id => graph.nodes[id]);
          const validVisible = saved.visibleNodes.filter(id => graph.nodes[id]);

          if (validExpanded.length > 0 || validVisible.length > 0) {
            expanded = new Set(validExpanded);
            visible = new Set(validVisible);
            restored = true;
            if (import.meta.env.DEV) {
              useDebugStore.getState().addLog(
                `Restored folder state: expanded=${expanded.size}, visible=${visible.size}`
              );
            }
          }
        }
      }

      // If no saved state, use defaults
      if (!restored) {
        for (const [nodeId, node] of Object.entries(graph.nodes)) {
          visible.add(nodeId);
          // Expand directories and files (so code blocks are visible)
          if ((node.type === "Directory" || node.type === "File") && node.children.length > 0) {
            expanded.add(nodeId);
          }
        }
      }

      if (import.meta.env.DEV) {
        useDebugStore.getState().addLog(
          `setGraph: nodes=${Object.keys(graph.nodes).length}, edges=${graph.edges.length}, expanded=${expanded.size}, visible=${visible.size}, restored=${restored}`
        );
      }
    }

    // Increment layoutVersion to trigger relayout
    set({
      graph,
      expandedNodes: expanded,
      visibleNodes: visible,
      needsRelayout: false,
      layoutVersion: get().layoutVersion + 1,
    });
  },

  setIsParsing: (v) =>
    set({
      isParsing: v,
      parseProgress: v
        ? {
            totalFiles: 0,
            parsedFiles: 0,
            totalBlocks: 0,
            currentFile: "",
            errors: [],
          }
        : null,
    }),

  handleParseEvent: (event) => {
    const progress = get().parseProgress;
    if (!progress) return;

    switch (event.type) {
      case "FileStart":
        set({
          parseProgress: { ...progress, currentFile: event.path },
        });
        break;
      case "FileDone":
        set({
          parseProgress: {
            ...progress,
            parsedFiles: progress.parsedFiles + 1,
            totalBlocks: progress.totalBlocks + event.blocks,
          },
        });
        break;
      case "Error":
        set({
          parseProgress: {
            ...progress,
            errors: [
              ...progress.errors,
              { path: event.path, message: event.message },
            ],
          },
        });
        break;
      case "Complete":
        set({
          parseProgress: {
            ...progress,
            totalFiles: event.total_files,
            totalBlocks: event.total_blocks,
          },
          isParsing: false,
        });
        break;
    }
  },

  toggleExpanded: (nodeId) => {
    const expanded = new Set(get().expandedNodes);
    if (expanded.has(nodeId)) {
      expanded.delete(nodeId);
    } else {
      expanded.add(nodeId);
    }
    set({ expandedNodes: expanded, needsRelayout: true });
  },

  setExpanded: (nodeId, isExpanded) => {
    const expanded = new Set(get().expandedNodes);
    if (isExpanded) {
      expanded.add(nodeId);
    } else {
      expanded.delete(nodeId);
    }
    set({ expandedNodes: expanded, needsRelayout: true });
  },

  toggleVisible: (nodeId) => {
    const visible = new Set(get().visibleNodes);
    const graph = get().graph;
    if (!graph) return;

    const toggleRecursive = (id: string, show: boolean) => {
      if (show) {
        visible.add(id);
      } else {
        visible.delete(id);
      }
      const node = graph.nodes[id];
      if (node) {
        for (const childId of node.children) {
          toggleRecursive(childId, show);
        }
      }
    };

    const shouldShow = !visible.has(nodeId);
    toggleRecursive(nodeId, shouldShow);
    set({ visibleNodes: visible, needsRelayout: true });
  },

  setSelectedNode: (nodeId) => set({ selectedNodeId: nodeId }),
  setHoveredNode: (nodeId) => set({ hoveredNodeId: nodeId }),

  toggleEdgeKind: (kind) => {
    const kinds = new Set(get().enabledEdgeKinds);
    if (kinds.has(kind)) {
      kinds.delete(kind);
    } else {
      kinds.add(kind);
    }
    // Trigger relayout since edge filtering affects layout
    set({
      enabledEdgeKinds: kinds,
      layoutVersion: get().layoutVersion + 1,
    });
  },

  getVisibleNodeIds: () => {
    return Array.from(get().visibleNodes);
  },

  requestRelayout: () => {
    const state = get();
    if (!state.needsRelayout) return;

    // Save current state before relayout
    if (state.repoPath) {
      saveFolderState(state.repoPath, state.expandedNodes, state.visibleNodes);
    }

    // Increment layoutVersion to trigger relayout in Canvas
    set({
      needsRelayout: false,
      layoutVersion: state.layoutVersion + 1,
    });
  },

  saveCurrentState: () => {
    const state = get();
    if (state.repoPath) {
      saveFolderState(state.repoPath, state.expandedNodes, state.visibleNodes);
    }
  },
}));
