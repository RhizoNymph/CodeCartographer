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

export interface HoveredEdgeInfo {
  kind: EdgeKind;
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  count: number;
}

export type GraphViewRelayoutMode = "none" | "defer" | "now";

export interface GraphViewPatch {
  expandedNodes?: Set<string>;
  visibleNodes?: Set<string>;
  enabledEdgeKinds?: Set<EdgeKind>;
  hideUnconnectedNodes?: boolean;
}

export interface GraphViewPatchOptions {
  relayout?: GraphViewRelayoutMode;
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

  // Layout state - manual relayout
  needsRelayout: boolean;
  layoutVersion: number; // Incremented when relayout should happen

  // Search state
  searchMatchIds: Set<string>;
  searchResultOrder: string[];
  searchResultIndex: number;

  // Zoom target (for sidebar -> canvas communication)
  pendingZoomNodeId: string | null;

  // Context menu state
  contextMenu: { nodeId: string; screenX: number; screenY: number } | null;

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
  setHoveredEdge: (info: HoveredEdgeInfo | null) => void;
  toggleEdgeKind: (kind: EdgeKind) => void;
  setHideUnconnectedNodes: (hide: boolean) => void;
  applyGraphViewPatch: (
    patch: GraphViewPatch,
    options?: GraphViewPatchOptions
  ) => void;
  getVisibleNodeIds: () => string[];
  requestRelayout: () => void;
  saveCurrentState: () => void;
  setSearchResults: (matchIds: Set<string>, directMatchOrder: string[]) => void;
  navigateSearchResult: (direction: "next" | "prev") => void;
  clearSearch: () => void;
  requestZoomToNode: (id: string | null) => void;
  setContextMenu: (menu: { nodeId: string; screenX: number; screenY: number } | null) => void;
  expandSubtree: (nodeId: string) => void;
  collapseSubtree: (nodeId: string) => void;
  hideSubtree: (nodeId: string) => void;
  showOnlyDependencies: (nodeId: string) => void;
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
  needsRelayout: false,
  layoutVersion: 0,
  searchMatchIds: new Set<string>(),
  searchResultOrder: [],
  searchResultIndex: -1,
  pendingZoomNodeId: null,
  contextMenu: null,

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
          // Only expand directories by default (progressive disclosure:
          // files start collapsed so code blocks are hidden initially)
          if (node.type === "Directory" && node.children.length > 0) {
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

  applyGraphViewPatch: (patch, options = {}) => {
    const state = get();
    const next: Partial<GraphState> = {};

    if (patch.expandedNodes !== undefined) {
      next.expandedNodes = new Set(patch.expandedNodes);
    }
    if (patch.visibleNodes !== undefined) {
      next.visibleNodes = new Set(patch.visibleNodes);
    }
    if (patch.enabledEdgeKinds !== undefined) {
      next.enabledEdgeKinds = new Set(patch.enabledEdgeKinds);
    }
    if (patch.hideUnconnectedNodes !== undefined) {
      next.hideUnconnectedNodes = patch.hideUnconnectedNodes;
    }

    switch (options.relayout ?? "now") {
      case "none":
        break;
      case "defer":
        next.needsRelayout = true;
        break;
      case "now":
        next.needsRelayout = false;
        next.layoutVersion = state.layoutVersion + 1;
        break;
    }

    set(next);
  },

  toggleExpanded: (nodeId) => {
    const expanded = new Set(get().expandedNodes);
    if (expanded.has(nodeId)) {
      expanded.delete(nodeId);
    } else {
      expanded.add(nodeId);
    }
    get().applyGraphViewPatch({ expandedNodes: expanded }, { relayout: "defer" });
  },

  setExpanded: (nodeId, isExpanded) => {
    const expanded = new Set(get().expandedNodes);
    if (isExpanded) {
      expanded.add(nodeId);
    } else {
      expanded.delete(nodeId);
    }
    get().applyGraphViewPatch({ expandedNodes: expanded }, { relayout: "defer" });
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
    get().applyGraphViewPatch({ visibleNodes: visible }, { relayout: "defer" });
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
    get().applyGraphViewPatch({ enabledEdgeKinds: kinds }, { relayout: "now" });
  },

  setHideUnconnectedNodes: (hide) => {
    if (get().hideUnconnectedNodes === hide) return;
    get().applyGraphViewPatch({ hideUnconnectedNodes: hide }, { relayout: "now" });
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

  setSearchResults: (matchIds, directMatchOrder) => {
    set({
      searchMatchIds: matchIds,
      searchResultOrder: directMatchOrder,
      searchResultIndex: directMatchOrder.length > 0 ? 0 : -1,
    });
  },

  navigateSearchResult: (direction) => {
    const { searchResultOrder, searchResultIndex } = get();
    if (searchResultOrder.length === 0) return;

    let newIndex: number;
    if (direction === "next") {
      newIndex = (searchResultIndex + 1) % searchResultOrder.length;
    } else {
      newIndex = (searchResultIndex - 1 + searchResultOrder.length) % searchResultOrder.length;
    }
    const nodeId = searchResultOrder[newIndex];
    set({
      searchResultIndex: newIndex,
      selectedNodeId: nodeId,
      pendingZoomNodeId: nodeId,
    });
  },

  clearSearch: () => {
    set({
      searchMatchIds: new Set<string>(),
      searchResultOrder: [],
      searchResultIndex: -1,
    });
  },

  requestZoomToNode: (id) => {
    set({ pendingZoomNodeId: id });
  },

  setContextMenu: (menu) => {
    set({ contextMenu: menu });
  },

  expandSubtree: (nodeId) => {
    const graph = get().graph;
    if (!graph) return;
    const expanded = new Set(get().expandedNodes);
    const addRecursive = (id: string) => {
      const node = graph.nodes[id];
      if (!node || node.children.length === 0) return;
      expanded.add(id);
      for (const childId of node.children) addRecursive(childId);
    };
    addRecursive(nodeId);
    set({ expandedNodes: expanded, needsRelayout: true });
  },

  collapseSubtree: (nodeId) => {
    const graph = get().graph;
    if (!graph) return;
    const expanded = new Set(get().expandedNodes);
    const removeRecursive = (id: string) => {
      expanded.delete(id);
      const node = graph.nodes[id];
      if (node) {
        for (const childId of node.children) removeRecursive(childId);
      }
    };
    removeRecursive(nodeId);
    set({ expandedNodes: expanded, needsRelayout: true });
  },

  hideSubtree: (nodeId) => {
    const graph = get().graph;
    if (!graph) return;
    const visible = new Set(get().visibleNodes);
    const removeRecursive = (id: string) => {
      visible.delete(id);
      const node = graph.nodes[id];
      if (node) {
        for (const childId of node.children) removeRecursive(childId);
      }
    };
    removeRecursive(nodeId);
    set({ visibleNodes: visible, needsRelayout: true });
  },

  showOnlyDependencies: (nodeId) => {
    const graph = get().graph;
    if (!graph) return;
    const enabledKinds = get().enabledEdgeKinds;
    const connected = new Set<string>([nodeId]);
    for (const edge of graph.edges) {
      if (!enabledKinds.has(edge.kind)) continue;
      if (edge.source === nodeId) connected.add(edge.target);
      if (edge.target === nodeId) connected.add(edge.source);
    }
    // Add ancestor paths for connected nodes
    const parentMap = new Map<string, string>();
    for (const [id, node] of Object.entries(graph.nodes)) {
      for (const childId of node.children) parentMap.set(childId, id);
    }
    const withAncestors = new Set(connected);
    for (const id of connected) {
      let current = parentMap.get(id);
      while (current) {
        withAncestors.add(current);
        current = parentMap.get(current);
      }
    }
    set({ visibleNodes: withAncestors, needsRelayout: true });
  },
}));
