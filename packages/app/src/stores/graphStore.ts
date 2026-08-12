import { create } from "zustand";
import type {
  CodeGraph,
  EdgeKind,
  FocusDirection,
  ParseEvent,
  ParseResult,
  Neighborhood,
  EdgeDetail,
} from "../api/types";
import { saveFolderState, loadFolderState, type ViewMode } from "./persistenceStore";
import { getNeighborhood, getEdgeDetail } from "../api/commands";
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
  effectiveEdgeKinds,
  type FocusFrame,
  type FocusViewState,
} from "./graphViewModel";
import { useDebugStore } from "./debugStore";
import {
  applyLayoutWork,
  layoutWorkFor,
  type GraphChange,
  type LayoutTriggers,
} from "./relayoutPolicy";
import {
  EMPTY_SELECTION,
  invalidateSelection,
  reduceSelection,
  resolveSelectionClick,
  selectionFromStore,
  selectionToStore,
  type SelectionAction,
} from "./selectionModel";

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
  /**
   * The selected node set -- the source of truth for selection AND for the
   * pinned edge highlight (selection and pin are the same concept). A plain
   * click replaces it with one node, ctrl/cmd-click toggles membership, and an
   * empty-canvas click or Esc clears it. Never mutated in place.
   */
  selectedNodeIds: ReadonlySet<string>;
  /**
   * The primary (last-selected) node, derived from `selectedNodeIds`.
   * Invariant: null iff `selectedNodeIds` is empty, otherwise a member of it.
   * This is what single-node consumers (SelectionChip, the F hotkey, the
   * sidebar's active row) read.
   */
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
   * frame is the one on screen and the payload below is that frame's: a node
   * frame's `focusNeighborhood` or an edge frame's `focusEdgeDetail` (exactly
   * one non-null while focused). The layout renders ONLY the payload's ids.
   * Focusing from inside a focused view pushes a deeper frame.
   */
  focusStack: FocusFrame[];
  focusNeighborhood: Neighborhood | null;
  focusEdgeDetail: EdgeDetail | null;

  /**
   * Layout triggers. Every state change is classified by `relayoutPolicy` into
   * the cheapest sufficient work, and at most ONE of these versions is bumped
   * per user action:
   *   - `layoutVersion` -> full ELK layout (node positions changed);
   *   - `edgeVersion`   -> edge-only phase (which edges show changed);
   *   - neither         -> the canvas's cheap visibility path, or nothing.
   * `needsRelayout` is a hint, not a queue: it means the positions on screen
   * were kept across a cheaper change, so the sidebar offers an explicit
   * "Apply Layout Changes" re-run. It never causes a layout by itself.
   */
  needsRelayout: boolean;
  layoutVersion: number;
  edgeVersion: number;

  // Actions
  setRepoPath: (path: string) => void;
  setGraph: (result: ParseResult, restoreState?: boolean) => void;
  setIsParsing: (v: boolean) => void;
  handleParseEvent: (event: ParseEvent) => void;
  toggleExpanded: (nodeId: string) => void;
  setExpanded: (nodeId: string, expanded: boolean) => void;
  toggleVisible: (nodeId: string) => void;
  /**
   * Select a node from a click. `additive` (ctrl/cmd held) toggles membership;
   * otherwise the selection is replaced with just this node.
   */
  selectNode: (nodeId: string, additive?: boolean) => void;
  /** Apply a selection action directly (used by the Esc handler and tests). */
  applySelectionAction: (action: SelectionAction) => void;
  /** Clear the selection (empty-canvas click, chip Clear button, Esc). */
  clearSelection: () => void;
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
  /** Push an edge focus frame for one aggregated `source -> target` view edge. */
  enterEdgeFocus: (source: string, target: string) => Promise<void>;
  /** Push any focus frame; the generic entry point behind the two above. */
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

interface FocusPayload {
  neighborhood: Neighborhood | null;
  edgeDetail: EdgeDetail | null;
}

/**
 * Fetch the render payload for one focus frame.
 *
 * Node frames run the cc-core neighborhood BFS in the frame's own direction and
 * depth, over the raw enabled kinds. Edge frames resolve the underlying edges
 * behind one aggregate via `get_edge_detail`, over the EFFECTIVE kinds of the
 * view the fetch starts from -- so a drill-in from module view expands exactly
 * the Import aggregate the user double-clicked, while a re-fetch from symbol
 * view (popping back to an edge frame) honours the toolbar's enabled kinds.
 */
async function fetchFramePayload(
  frame: FocusFrame,
  state: GraphState
): Promise<FocusPayload> {
  if (frame.type === "edge") {
    const kinds = Array.from(
      effectiveEdgeKinds(state.enabledEdgeKinds, state.viewMode)
    );
    return {
      neighborhood: null,
      edgeDetail: await getEdgeDetail(frame.source, frame.target, kinds),
    };
  }
  return {
    neighborhood: await getNeighborhood(
      frame.nodeId,
      frame.depth,
      Array.from(state.enabledEdgeKinds),
      frame.direction
    ),
    edgeDetail: null,
  };
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
      focusEdgeDetail: null,
      ...layoutTriggers(cur, { kind: "focus" }),
    });
    return;
  }

  try {
    const payload = await fetchFramePayload(top, cur);
    set({
      viewMode: next.viewMode,
      focusStack: next.focusStack,
      focusNeighborhood: payload.neighborhood,
      focusEdgeDetail: payload.edgeDetail,
      // Keep the selection (and therefore the pin) on the frame being entered so
      // the sidebar and chips agree with the canvas; an edge frame focuses a
      // relation, not a node, so it clears the selection. Always written via
      // selectionToStore so selectedNodeIds/selectedNodeId stay consistent.
      ...selectionToStore(
        top.type === "node"
          ? reduceSelection(EMPTY_SELECTION, { kind: "replace", nodeId: top.nodeId })
          : EMPTY_SELECTION
      ),
      ...layoutTriggers(get(), { kind: "focus" }),
    });
  } catch (err) {
    console.error("focus frame fetch failed:", err);
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`focus frame fetch FAILED: ${err}`);
    }
  }
}

/**
 * Classify a state change with the relayout policy and fold the answer into the
 * store's trigger counters. This is the ONE place that decides whether a user
 * action costs a full ELK layout, an edge-only pass, or nothing at all.
 */
function layoutTriggers(state: GraphState, change: GraphChange): LayoutTriggers {
  const work = layoutWorkFor(change, {
    viewMode: state.viewMode,
    focusActive: state.focusStack.length > 0,
    hideUnconnectedNodes: state.hideUnconnectedNodes,
  });
  return applyLayoutWork(work, {
    layoutVersion: state.layoutVersion,
    edgeVersion: state.edgeVersion,
    needsRelayout: state.needsRelayout,
  });
}

/** Hovered-edge identity, so repeated pointer events do not wake subscribers. */
function sameHoveredEdge(
  a: HoveredEdgeInfo | null,
  b: HoveredEdgeInfo | null
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.kind === b.kind &&
    a.sourceId === b.sourceId &&
    a.targetId === b.targetId &&
    a.count === b.count
  );
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
  ...selectionToStore(EMPTY_SELECTION),
  hoveredNodeId: null,
  hoveredEdgeInfo: null,
  enabledEdgeKinds: new Set<EdgeKind>(ALL_EDGE_KINDS),
  hideUnconnectedNodes: false,
  hideAmbiguousEdges: false,
  viewMode: "module",
  focusStack: [],
  focusNeighborhood: null,
  focusEdgeDetail: null,
  needsRelayout: false,
  layoutVersion: 0,
  edgeVersion: 0,

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

    // Selection is pinned across relayouts but not across graphs: ids that no
    // longer exist are dropped (usually all of them on a fresh parse).
    const cur = get();
    const selection = invalidateSelection(
      selectionFromStore(cur.selectedNodeIds, cur.selectedNodeId),
      (id) => graph.nodes[id] !== undefined
    );

    // A fresh graph is a full layout (and clears any active focus).
    set({
      graph,
      expandedNodes: expanded,
      visibleNodes: visible,
      viewMode,
      focusStack: [],
      ...selectionToStore(selection),
      focusNeighborhood: null,
      focusEdgeDetail: null,
      ...layoutTriggers(cur, { kind: "graph-replaced" }),
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

  /**
   * Apply one BATCHED progress event: exactly one store broadcast per batch
   * (~100 files or ~50ms of parsing) rather than one per file per phase, so
   * ingesting a large repo no longer re-renders every subscriber thousands of
   * times. The counts are cumulative and authoritative -- they are assigned, not
   * accumulated, so a dropped or duplicated batch cannot skew the progress bar.
   */
  handleParseEvent: (event) => {
    const progress = get().parseProgress;
    if (!progress) return;

    switch (event.type) {
      case "Progress":
        set({
          parseProgress: {
            ...progress,
            parsedFiles: event.parsed_files,
            totalFiles: event.total_files,
            totalBlocks: event.total_blocks,
            currentFile: event.current_file,
            errors:
              event.errors.length > 0
                ? [...progress.errors, ...event.errors]
                : progress.errors,
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
    const cur = get();
    const expanded = new Set(cur.expandedNodes);
    if (expanded.has(nodeId)) {
      expanded.delete(nodeId);
    } else {
      expanded.add(nodeId);
    }
    // Expansion changes the containment tree, so it relayouts immediately --
    // except where the view derives expansion itself (module view files, focus).
    set({
      expandedNodes: expanded,
      ...layoutTriggers(cur, {
        kind: "expansion",
        nodeType: cur.graph?.nodes[nodeId]?.type ?? null,
      }),
    });
  },

  setExpanded: (nodeId, isExpanded) => {
    const cur = get();
    const expanded = new Set(cur.expandedNodes);
    if (isExpanded) {
      expanded.add(nodeId);
    } else {
      expanded.delete(nodeId);
    }
    set({
      expandedNodes: expanded,
      ...layoutTriggers(cur, {
        kind: "expansion",
        nodeType: cur.graph?.nodes[nodeId]?.type ?? null,
      }),
    });
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
    // Hiding only removes nodes that are already laid out (cheap canvas path);
    // showing can reveal nodes that were never given a position, which needs a
    // real layout.
    set({
      visibleNodes: visible,
      ...layoutTriggers(get(), { kind: "visibility", showing: shouldShow }),
    });
  },

  selectNode: (nodeId, additive = false) =>
    get().applySelectionAction(
      resolveSelectionClick(nodeId, { ctrlKey: additive, metaKey: false })
    ),

  applySelectionAction: (action) => {
    const cur = get();
    const next = reduceSelection(
      selectionFromStore(cur.selectedNodeIds, cur.selectedNodeId),
      action
    );
    set(selectionToStore(next));
  },

  clearSelection: () => get().applySelectionAction({ kind: "clear" }),

  // Pixi fires hover events continuously (including repeated nulls); an equality
  // guard keeps every store subscriber asleep unless the hover really changed.
  setHoveredNode: (nodeId) => {
    if (get().hoveredNodeId === nodeId) return;
    set({ hoveredNodeId: nodeId });
  },

  setHoveredEdge: (info) => {
    if (sameHoveredEdge(get().hoveredEdgeInfo, info)) return;
    set({ hoveredEdgeInfo: info });
  },

  toggleEdgeKind: (kind) => {
    const cur = get();
    const kinds = new Set(cur.enabledEdgeKinds);
    if (kinds.has(kind)) {
      kinds.delete(kind);
    } else {
      kinds.add(kind);
    }
    // Which edges show, not where the nodes are: the edge phase suffices unless
    // the unconnected filter makes the node set depend on the kinds.
    set({
      enabledEdgeKinds: kinds,
      ...layoutTriggers(cur, { kind: "edge-kinds" }),
    });
  },

  setHideUnconnectedNodes: (hide) => {
    const cur = get();
    if (cur.hideUnconnectedNodes === hide) return;
    set({
      hideUnconnectedNodes: hide,
      ...layoutTriggers(cur, { kind: "hide-unconnected" }),
    });
  },

  setHideAmbiguousEdges: (hide) => {
    const cur = get();
    if (cur.hideAmbiguousEdges === hide) return;
    // A pure client-side edge filter -- never a reason to move nodes.
    set({
      hideAmbiguousEdges: hide,
      ...layoutTriggers(cur, { kind: "hide-ambiguous" }),
    });
  },

  setViewMode: (mode) => {
    const cur = get();
    if (cur.viewMode === mode) return;
    // Switching modes is a derived-view change: persist the new mode and bump
    // layoutVersion so the canvas relayouts. Leaving symbol view also drops the
    // whole focus stack (and with it both payloads).
    const reduced = reduceSetViewMode(
      { viewMode: cur.viewMode, focusStack: cur.focusStack },
      mode
    );
    const keepPayload = reduced.focusStack.length > 0;
    set({
      viewMode: reduced.viewMode,
      focusStack: reduced.focusStack,
      focusNeighborhood: keepPayload ? cur.focusNeighborhood : null,
      focusEdgeDetail: keepPayload ? cur.focusEdgeDetail : null,
      ...layoutTriggers(cur, { kind: "view-mode" }),
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

  /**
   * Drill into one aggregated `source -> target` view edge: push an edge frame
   * whose payload is the underlying edges behind that aggregate (fetched with
   * the current view's EFFECTIVE kinds -- see `fetchFramePayload`).
   */
  enterEdgeFocus: async (source, target) => {
    const state = get();
    if (!state.graph) return;
    if (!state.graph.nodes[source] || !state.graph.nodes[target]) return;
    await get().pushFocusFrame({ type: "edge", source, target });
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
      focusEdgeDetail: null,
      ...layoutTriggers(cur, { kind: "focus" }),
    });
  },

  getVisibleNodeIds: () => {
    return Array.from(get().visibleNodes);
  },

  /**
   * The explicit "Apply Layout Changes" button: re-solve the node positions for
   * whatever the state is now. This is the ONLY unconditional full layout -- the
   * cheaper paths above never queue one behind themselves, so a user action can
   * never cost two layouts.
   */
  requestRelayout: () => {
    const state = get();

    // Save current state before relayout
    if (state.repoPath) {
      saveFolderState(
        state.repoPath,
        state.expandedNodes,
        state.visibleNodes,
        state.viewMode
      );
    }

    set(layoutTriggers(state, { kind: "relayout-requested" }));
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
