import { create } from "zustand";
import type { CodeGraph, EdgeKind, ParseEvent, ParseResult, Neighborhood } from "../api/types";
import { saveFolderState, loadFolderState, type ViewMode } from "./persistenceStore";
import { getNeighborhood } from "../api/commands";
import {
  reduceSetViewMode,
  reduceEnterFocus,
  reduceExitFocus,
} from "./graphViewModel";
import { useDebugStore } from "./debugStore";

/**
 * Convert the edge-less `ParseResult` IPC payload into the frontend `CodeGraph`,
 * turning the plain connectivity record into a Map for fast lookup.
 */
function parseResultToGraph(result: ParseResult): CodeGraph {
  return {
    nodes: result.nodes,
    root: result.root,
    edgeCount: result.edge_count,
    nodeEdgeKinds: new Map(Object.entries(result.node_edge_kinds)),
  };
}

interface ParseProgress {
  totalFiles: number;
  parsedFiles: number;
  totalBlocks: number;
  currentFile: string;
  errors: Array<{ path: string; message: string }>;
}

export interface HoveredEdgeInfo {
  kind: EdgeKind;
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  count: number;
}

interface GraphState {
  // Source path
  repoPath: string | null;

  // The full code graph from backend
  graph: CodeGraph | null;

  // Parsing state
  isParsing: boolean;
  parseProgress: ParseProgress | null;

  /** Which container nodes (directories/files) have their children shown in the graph layout.
   *  Controls the ELK tree structure -- expanded nodes include their children as ELK sub-nodes. */
  expandedNodes: Set<string>;

  /** Which nodes are checkbox-toggled as visible in the sidebar.
   *  Controls both sidebar checkbox state and canvas node rendering.
   *  Independent from expandedNodes -- a node can be visible but collapsed. */
  visibleNodes: Set<string>;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;

  /** Info about the edge currently being hovered (edge tooltip). */
  hoveredEdgeInfo: HoveredEdgeInfo | null;

  // Edge filter state
  enabledEdgeKinds: Set<EdgeKind>;
  hideUnconnectedNodes: boolean;
  /** When true, ambiguous (low-confidence) edges are hidden from the layout. */
  hideAmbiguousEdges: boolean;

  /**
   * Zoom-level view. "module" (default) is the trustworthy import view: files
   * render collapsed and only Import edges show. "symbol" is the detailed view
   * with expandable files and all enabled edge kinds. Persisted per folder.
   */
  viewMode: ViewMode;

  /**
   * Focus / drill-down state. When `focusNodeId` is set, the layout renders ONLY
   * the fetched `focusNeighborhood` ids + edges (a bounded symbol neighborhood).
   */
  focusNodeId: string | null;
  focusDepth: 1 | 2;
  focusNeighborhood: Neighborhood | null;

  // Layout state - manual relayout
  needsRelayout: boolean;
  layoutVersion: number; // Incremented when relayout should happen

  // Actions
  setRepoPath: (path: string) => void;
  setGraph: (result: ParseResult, restoreState?: boolean) => void;
  setIsParsing: (v: boolean) => void;
  handleParseEvent: (event: ParseEvent) => void;
  toggleExpanded: (nodeId: string) => void;
  setExpanded: (nodeId: string, expanded: boolean) => void;
  toggleVisible: (nodeId: string) => void;
  setSelectedNode: (nodeId: string | null) => void;
  setHoveredNode: (nodeId: string | null) => void;
  setHoveredEdge: (info: HoveredEdgeInfo | null) => void;
  toggleEdgeKind: (kind: EdgeKind) => void;
  setHideUnconnectedNodes: (hide: boolean) => void;
  setHideAmbiguousEdges: (hide: boolean) => void;
  setViewMode: (mode: ViewMode) => void;
  enterFocus: (nodeId: string, depth?: 1 | 2) => Promise<void>;
  setFocusDepth: (depth: 1 | 2) => Promise<void>;
  exitFocus: () => void;
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
  hoveredEdgeInfo: null,
  enabledEdgeKinds: new Set<EdgeKind>(ALL_EDGE_KINDS),
  hideUnconnectedNodes: false,
  hideAmbiguousEdges: false,
  viewMode: "module",
  focusNodeId: null,
  focusDepth: 1,
  focusNeighborhood: null,
  needsRelayout: false,
  layoutVersion: 0,

  setRepoPath: (path) => set({ repoPath: path }),

  setGraph: (result, restoreState = true) => {
    const graph = parseResultToGraph(result);
    const repoPath = get().repoPath;
    let expanded = new Set<string>();
    let visible = new Set<string>();
    // Default to the trustworthy module view; overridden by a restored state.
    let viewMode: ViewMode = "module";

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
            viewMode = saved.viewMode ?? "module";
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
          // Only expand directories by default (progressive disclosure:
          // files start collapsed so code blocks are hidden initially)
          if (node.type === "Directory" && node.children.length > 0) {
            expanded.add(nodeId);
          }
        }
      }

      if (import.meta.env.DEV) {
        useDebugStore.getState().addLog(
          `setGraph: nodes=${Object.keys(graph.nodes).length}, edges=${graph.edgeCount}, expanded=${expanded.size}, visible=${visible.size}, restored=${restored}`
        );
      }
    }

    // Increment layoutVersion to trigger relayout. A fresh graph clears any
    // active focus.
    set({
      graph,
      expandedNodes: expanded,
      visibleNodes: visible,
      viewMode,
      focusNodeId: null,
      focusNeighborhood: null,
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
  setHoveredEdge: (info) => set({ hoveredEdgeInfo: info }),

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

  setHideUnconnectedNodes: (hide) => {
    if (get().hideUnconnectedNodes === hide) return;
    set({
      hideUnconnectedNodes: hide,
      layoutVersion: get().layoutVersion + 1,
    });
  },

  setHideAmbiguousEdges: (hide) => {
    if (get().hideAmbiguousEdges === hide) return;
    set({
      hideAmbiguousEdges: hide,
      layoutVersion: get().layoutVersion + 1,
    });
  },

  setViewMode: (mode) => {
    const cur = get();
    if (cur.viewMode === mode) return;
    // Switching modes is a derived-view change: persist the new mode and bump
    // layoutVersion so the canvas relayouts. Leaving symbol view also drops any
    // active focus.
    const reduced = reduceSetViewMode(
      { viewMode: cur.viewMode, focusNodeId: cur.focusNodeId, focusDepth: cur.focusDepth },
      mode
    );
    set({
      viewMode: reduced.viewMode,
      focusNodeId: reduced.focusNodeId,
      focusNeighborhood: reduced.focusNodeId === null ? null : cur.focusNeighborhood,
      layoutVersion: cur.layoutVersion + 1,
    });
    const state = get();
    if (state.repoPath) {
      saveFolderState(
        state.repoPath,
        state.expandedNodes,
        state.visibleNodes,
        state.viewMode
      );
    }
  },

  enterFocus: async (nodeId, depth = get().focusDepth) => {
    const state = get();
    if (!state.graph || !state.graph.nodes[nodeId]) return;
    // Entering focus always drills into the symbol view.
    const kinds = Array.from(state.enabledEdgeKinds);
    try {
      const neighborhood = await getNeighborhood(nodeId, depth, kinds);
      const reduced = reduceEnterFocus(
        { viewMode: state.viewMode, focusNodeId: state.focusNodeId, focusDepth: state.focusDepth },
        nodeId,
        depth
      );
      set({
        viewMode: reduced.viewMode,
        focusNodeId: reduced.focusNodeId,
        focusDepth: reduced.focusDepth,
        focusNeighborhood: neighborhood,
        selectedNodeId: nodeId,
        layoutVersion: get().layoutVersion + 1,
      });
    } catch (err) {
      console.error("get_neighborhood failed:", err);
      if (import.meta.env.DEV) {
        useDebugStore.getState().addLog(`get_neighborhood FAILED: ${err}`);
      }
    }
  },

  setFocusDepth: async (depth) => {
    const state = get();
    if (state.focusDepth === depth && state.focusNeighborhood) return;
    if (!state.focusNodeId) {
      set({ focusDepth: depth });
      return;
    }
    // Re-fetch the neighborhood at the new depth for the current focus node.
    await get().enterFocus(state.focusNodeId, depth);
  },

  exitFocus: () => {
    const cur = get();
    if (!cur.focusNodeId) return;
    const reduced = reduceExitFocus({
      viewMode: cur.viewMode,
      focusNodeId: cur.focusNodeId,
      focusDepth: cur.focusDepth,
    });
    set({
      focusNodeId: reduced.focusNodeId,
      focusNeighborhood: null,
      layoutVersion: cur.layoutVersion + 1,
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
      saveFolderState(
        state.repoPath,
        state.expandedNodes,
        state.visibleNodes,
        state.viewMode
      );
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
      saveFolderState(
        state.repoPath,
        state.expandedNodes,
        state.visibleNodes,
        state.viewMode
      );
    }
  },
}));
