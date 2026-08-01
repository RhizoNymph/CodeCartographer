import type {
  CodeGraph,
  CodeNode,
  EdgeKind,
  EdgeDetail,
  Neighborhood,
} from "../api/types";

export type ViewMode = "module" | "symbol";

/**
 * Derivation helpers for the two-view zoom model.
 *
 * Module view is a set of DERIVED constraints on top of the user's saved
 * expansion/edge-kind state, never a mutation of it:
 *   - files are treated as NOT expanded (their saved expansion is preserved but
 *     ignored) so no symbol-level detail is laid out;
 *   - effective edge kinds are forced to {Import} regardless of the toolbar
 *     toggles, because the zoomed-out view is the trustworthy import graph.
 *
 * Symbol view passes the user's state through unchanged.
 */

const IMPORT_ONLY: ReadonlySet<EdgeKind> = new Set<EdgeKind>(["Import"]);

/**
 * The effective set of expanded node ids for the given view mode. In module
 * view, File nodes are removed from the expanded set (so their code blocks are
 * never included in the ELK tree); Directory expansion is preserved so the
 * folder structure still lays out. In symbol view the set is returned as-is.
 */
export function effectiveExpandedNodes(
  graph: CodeGraph | null,
  expandedNodes: Set<string>,
  viewMode: ViewMode
): Set<string> {
  if (viewMode === "symbol" || !graph) return expandedNodes;

  const result = new Set<string>();
  for (const id of expandedNodes) {
    const node = graph.nodes[id];
    // Keep directories expanded; drop files (and anything else) so files render
    // collapsed and no CodeBlock children enter the layout.
    if (node && node.type === "Directory") {
      result.add(id);
    }
  }
  return result;
}

/**
 * The effective enabled edge kinds for the given view mode. Module view forces
 * {Import}; symbol view uses the caller's set unchanged.
 */
export function effectiveEdgeKinds(
  enabledEdgeKinds: Set<EdgeKind>,
  viewMode: ViewMode
): Set<EdgeKind> {
  if (viewMode === "symbol") return enabledEdgeKinds;
  return new Set<EdgeKind>(IMPORT_ONLY);
}

/**
 * Whether ambiguous-edge filtering is meaningful in this view. Module view only
 * shows Import edges, which are exact, so the ambiguous filter is irrelevant.
 */
export function effectiveHideAmbiguous(
  hideAmbiguousEdges: boolean,
  viewMode: ViewMode
): boolean {
  return viewMode === "module" ? false : hideAmbiguousEdges;
}

/**
 * Build the effective visible-node set for an active focus. Only the focus ids
 * (which already include the container chain up to the root) are visible;
 * everything else is hidden. Intersected with the ids that exist in the graph
 * for safety. `focusIds` comes from a node focus's `Neighborhood` or an edge
 * focus's `EdgeDetail` -- both use the same id convention.
 */
export function focusVisibleNodes(
  graph: CodeGraph | null,
  focusIds: string[]
): Set<string> {
  const result = new Set<string>();
  if (!graph) return result;
  for (const id of focusIds) {
    if (graph.nodes[id]) result.add(id);
  }
  return result;
}

/**
 * Build the effective expanded-node set for an active focus: every container in
 * the focus set (Directory or File that has a child also in the set) must be
 * expanded so the ELK containment tree renders the focused symbols inside their
 * context boxes.
 */
export function focusExpandedNodes(
  graph: CodeGraph | null,
  focusIds: string[]
): Set<string> {
  const result = new Set<string>();
  if (!graph) return result;
  const idSet = new Set(focusIds);
  for (const id of focusIds) {
    const node: CodeNode | undefined = graph.nodes[id];
    if (!node) continue;
    if (node.type === "CodeBlock") continue;
    // Expand this container if any of its children are in the neighborhood.
    if (node.children.some((childId) => idSet.has(childId))) {
      result.add(id);
    }
  }
  return result;
}

/**
 * What the user drilled into. A focus is always one of these frames:
 *
 *   - "node": a bounded neighborhood around a node, `depth` hops out;
 *   - "edge": the underlying edges behind ONE aggregated `source -> target`
 *     view edge -- the answer to "what are these 14 imports?".
 *
 * The frame is the identity of the focus; the fetched payload
 * (`Neighborhood` / `EdgeDetail`) is cached alongside it in the store.
 */
export type FocusFrame =
  | { type: "node"; nodeId: string; depth: 1 | 2 }
  | { type: "edge"; source: string; target: string };

/**
 * Focus / view reducer state. Kept pure and framework-free so the transition
 * logic is unit-testable without the Tauri/zustand runtime.
 */
export interface FocusFrameState {
  viewMode: ViewMode;
  frame: FocusFrame | null;
}

/**
 * Switching view mode. Entering module view always drops the focus frame
 * (module view has no symbol-level drill-in); symbol view is left as-is.
 */
export function reduceSetViewModeFrame(
  state: FocusFrameState,
  mode: ViewMode
): FocusFrameState {
  if (mode === "module") {
    return { viewMode: "module", frame: null };
  }
  return { ...state, viewMode: "symbol" };
}

/** Focusing a node always drills into symbol view; replaces any active frame. */
export function reduceEnterNodeFocus(
  state: FocusFrameState,
  nodeId: string,
  depth: 1 | 2
): FocusFrameState {
  void state;
  return { viewMode: "symbol", frame: { type: "node", nodeId, depth } };
}

/**
 * Drilling into an aggregated `source -> target` edge. Like node focus this
 * always lands in symbol view, since the contributing endpoints are symbols.
 */
export function reduceEnterEdgeFocus(
  state: FocusFrameState,
  source: string,
  target: string
): FocusFrameState {
  void state;
  return { viewMode: "symbol", frame: { type: "edge", source, target } };
}

/** Exiting focus clears the frame but leaves the (symbol) view mode. */
export function reduceExitFocusFrame(state: FocusFrameState): FocusFrameState {
  return { ...state, frame: null };
}

/**
 * The node a focus is centred on, or null for an edge focus (which is centred
 * on a pair, not a node). Drives node-centric UI such as the F-hotkey's
 * "already focused" check and the selection chip.
 */
export function focusedNodeId(frame: FocusFrame | null): string | null {
  return frame && frame.type === "node" ? frame.nodeId : null;
}

/**
 * Whether hop depth is meaningful for this frame. Edge focus is exact -- it
 * shows the edges that make up one aggregate, not a BFS radius -- so the depth
 * selector is hidden there.
 */
export function focusHasDepth(frame: FocusFrame | null): boolean {
  return frame !== null && frame.type === "node";
}

/** What the focus breadcrumb chip renders, resolved to display names. */
export type FocusBreadcrumbModel =
  | { type: "node"; label: string; depth: 1 | 2 }
  | { type: "edge"; sourceLabel: string; targetLabel: string };

/**
 * Resolve a frame into breadcrumb labels, falling back to raw ids for nodes no
 * longer in the graph. Null when there is no focus (or no graph yet).
 */
export function focusBreadcrumbModel(
  graph: CodeGraph | null,
  frame: FocusFrame | null
): FocusBreadcrumbModel | null {
  if (!graph || !frame) return null;
  const label = (id: string) => graph.nodes[id]?.name ?? id;
  if (frame.type === "node") {
    return { type: "node", label: label(frame.nodeId), depth: frame.depth };
  }
  return {
    type: "edge",
    sourceLabel: label(frame.source),
    targetLabel: label(frame.target),
  };
}

/**
 * The ids the canvas must lay out for the active focus: the neighborhood ids for
 * a node frame, the edge-detail ids for an edge frame. Null when there is no
 * focus, or when the payload for the active frame has not arrived yet -- in
 * which case the canvas keeps its normal (unfocused) derivation.
 */
export function focusLayoutIds(
  frame: FocusFrame | null,
  neighborhood: Neighborhood | null,
  edgeDetail: EdgeDetail | null
): string[] | null {
  if (!frame) return null;
  if (frame.type === "node") return neighborhood ? neighborhood.node_ids : null;
  return edgeDetail ? edgeDetail.node_ids : null;
}

/**
 * Pre-frame node-only projection of the focus state, still exercised directly by
 * `focusReducer.test.ts`. New code uses `FocusFrameState` and the frame reducers
 * above, which additionally cover edge focus.
 */
export interface FocusViewState {
  viewMode: ViewMode;
  focusNodeId: string | null;
  focusDepth: 1 | 2;
}

/**
 * Switching view mode. Entering module view always drops any active focus
 * (module view has no symbol neighborhood); symbol view is left as-is.
 */
export function reduceSetViewMode(
  state: FocusViewState,
  mode: ViewMode
): FocusViewState {
  if (mode === "module") {
    return { ...state, viewMode: "module", focusNodeId: null };
  }
  return { ...state, viewMode: "symbol" };
}

/**
 * Entering focus on a node always drills into the symbol view and records the
 * focus node + depth.
 */
export function reduceEnterFocus(
  state: FocusViewState,
  nodeId: string,
  depth: 1 | 2
): FocusViewState {
  return { viewMode: "symbol", focusNodeId: nodeId, focusDepth: depth };
}

/** Exiting focus clears the focus node but leaves the (symbol) view mode. */
export function reduceExitFocus(state: FocusViewState): FocusViewState {
  return { ...state, focusNodeId: null };
}
