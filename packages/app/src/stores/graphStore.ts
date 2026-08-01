import { create } from "zustand";
import type {
  CodeGraph,
  EdgeKind,
  FocusDirection,
  ParseEvent,
  ParseResult,
  Neighborhood,
} from "../api/types";
import { saveFolderState, loadFolderState, type ViewMode } from "./persistenceStore";
import { getNeighborhood } from "../api/commands";
import {
  reduceSetViewMode,
  reduceEnterFocus,
  reduceExitFocus,
  reducePopFocus,
  reducePopToFrame,
  reduceSetFocusDepth,
  reduceSetFocusDirection,
  focusTopFrame,
  nodeFrame,
  type FocusFrame,
  type FocusViewState,
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
   * Focus / drill-down state. `focusStack` is empty when unfocused; its LAST
   * frame is the one on screen, and `focusNeighborhood` is that frame's fetched
   * neighborhood (the layout renders ONLY those ids + edges). Focusing a node
   * from inside a focused view pushes a deeper frame.
   */
  focusStack: FocusFrame[];
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
  /** Push (or replace, if it is already the top frame) a node focus frame. */
  enterFocus: (
    nodeId: string,
    depth?: 1 | 2,
    direction?: FocusDirection
  ) => Promise<void>;
  /** Push any focus frame; the generic entry point behind `enterFocus`. */
  pushFocusFrame: (frame: FocusFrame) => Promise<void>;
  setFocusDepth: (depth: 1 | 2) => Promise<void>;
  setFocusDirection: (direction: FocusDirection) => Promise<void>;
  /** Pop exactly one frame (Esc); focus ends only when the stack empties. */
  popFocus: () => Promise<void>;
  /** Pop back to the breadcrumb frame at `index`; `-1` is the root chip. */
  popToFrame: (index: number) => Promise<void>;
  /** Clear the whole stack at once (breadcrumb X). */
  exitFocus: () => void;
  getVisibleNodeIds: () => string[];
  requestRelayout: () => void;
  saveCurrentState: () => void;
}

/**
 * Fetch the render payload for one focus frame.
 *
 * Node frames run the cc-core neighborhood BFS in the frame's own direction and
 * depth. Edge frames are resolved by `get_edge_detail` (feat/edge-drill-in);
 * this branch never constructs one, so the null keeps the mechanics honest
 * without pretending to render something it cannot fetch.
 */
async function fetchFrameNeighborhood(
  frame: FocusFrame,
  edgeKinds: EdgeKind[]
): Promise<Neighborhood | null> {
  if (frame.type === "edge") return null;
  return getNeighborhood(frame.nodeId, frame.depth, edgeKinds, frame.direction);
}

/**
 * Apply a reduced focus state: fetch the new top frame's neighborhood and commit
 * both together, so `focusNeighborhood` always belongs to the top frame. An
 * empty stack clears focus without any IPC. A failed fetch leaves the current
 * state untouched rather than stranding the canvas on a stale neighborhood.
 */
async function applyFocusState(
  set: (partial: Partial<GraphState>) => void,
  get: () => GraphState,
  next: FocusViewState
): Promise<void> {
  const cur = get();
  const top = focusTopFrame(next.focusStack);

  if (top === null) {
    set({
      viewMode: next.viewMode,
      focusStack: [],
      focusNeighborhood: null,
      layoutVersion: cur.layoutVersion + 1,
    });
    return;
  }

  try {
    const neighborhood = await fetchFrameNeighborhood(
      top,
      Array.from(cur.enabledEdgeKinds)
    );
    set({
      viewMode: next.viewMode,
      focusStack: next.focusStack,
      focusNeighborhood: neighborhood,
      // Keep the selection on the frame being entered so the sidebar and chips
      // agree with the canvas.
      selectedNodeId: top.type === "node" ? top.nodeId : get().selectedNodeId,
      layoutVersion: get().layoutVersion + 1,
    });
  } catch (err) {
    console.error("focus frame fetch failed:", err);
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`focus frame fetch FAILED: ${err}`);
    }
  }
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
  focusStack: [],
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
      focusStack: [],
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
    // layoutVersion so the canvas relayouts. Leaving symbol view also drops the
    // whole focus stack.
    const reduced = reduceSetViewMode(
      { viewMode: cur.viewMode, focusStack: cur.focusStack },
      mode
    );
    set({
      viewMode: reduced.viewMode,
      focusStack: reduced.focusStack,
      focusNeighborhood:
        reduced.focusStack.length === 0 ? null : cur.focusNeighborhood,
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

  enterFocus: async (nodeId, depth, direction) => {
    const state = get();
    if (!state.graph || !state.graph.nodes[nodeId]) return;
    // Unspecified depth/direction inherit the current frame's, so drilling
    // deeper keeps the trace settings the user chose.
    const top = focusTopFrame(state.focusStack);
    const inherited =
      top !== null && top.type === "node"
        ? { depth: top.depth, direction: top.direction }
        : { depth: 1 as const, direction: "both" as const };
    await get().pushFocusFrame(
      nodeFrame(nodeId, depth ?? inherited.depth, direction ?? inherited.direction)
    );
  },

  pushFocusFrame: async (frame) => {
    const cur = get();
    const reduced = reduceEnterFocus(
      { viewMode: cur.viewMode, focusStack: cur.focusStack },
      frame
    );
    await applyFocusState(set, get, reduced);
  },

  setFocusDepth: async (depth) => {
    const cur = get();
    const top = focusTopFrame(cur.focusStack);
    if (top === null || top.type !== "node") return;
    if (top.depth === depth && cur.focusNeighborhood) return;
    const reduced = reduceSetFocusDepth(
      { viewMode: cur.viewMode, focusStack: cur.focusStack },
      depth
    );
    await applyFocusState(set, get, reduced);
  },

  setFocusDirection: async (direction) => {
    const cur = get();
    const top = focusTopFrame(cur.focusStack);
    if (top === null || top.type !== "node") return;
    if (top.direction === direction && cur.focusNeighborhood) return;
    const reduced = reduceSetFocusDirection(
      { viewMode: cur.viewMode, focusStack: cur.focusStack },
      direction
    );
    await applyFocusState(set, get, reduced);
  },

  popFocus: async () => {
    const cur = get();
    if (cur.focusStack.length === 0) return;
    const reduced = reducePopFocus({
      viewMode: cur.viewMode,
      focusStack: cur.focusStack,
    });
    // The revealed frame needs its own neighborhood re-fetched.
    await applyFocusState(set, get, reduced);
  },

  popToFrame: async (index) => {
    const cur = get();
    if (cur.focusStack.length === 0) return;
    const reduced = reducePopToFrame(
      { viewMode: cur.viewMode, focusStack: cur.focusStack },
      index
    );
    if (reduced.focusStack.length === cur.focusStack.length) return;
    await applyFocusState(set, get, reduced);
  },

  exitFocus: () => {
    const cur = get();
    if (cur.focusStack.length === 0) return;
    const reduced = reduceExitFocus({
      viewMode: cur.viewMode,
      focusStack: cur.focusStack,
    });
    set({
      focusStack: reduced.focusStack,
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
