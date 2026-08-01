import type { CodeGraph, CodeNode, EdgeKind, FocusDirection } from "../api/types";

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
 * Build the effective visible-node set for a focus neighborhood. Only the
 * neighborhood ids (which already include the container chain up to the root)
 * are visible; everything else is hidden. Intersected with the ids that exist in
 * the graph for safety.
 */
export function focusVisibleNodes(
  graph: CodeGraph | null,
  neighborhoodIds: string[]
): Set<string> {
  const result = new Set<string>();
  if (!graph) return result;
  for (const id of neighborhoodIds) {
    if (graph.nodes[id]) result.add(id);
  }
  return result;
}

/**
 * Build the effective expanded-node set for a focus neighborhood: every
 * container in the neighborhood (Directory or File that has a child also in the
 * neighborhood) must be expanded so the ELK containment tree renders the
 * focused symbols inside their context boxes.
 */
export function focusExpandedNodes(
  graph: CodeGraph | null,
  neighborhoodIds: string[]
): Set<string> {
  const result = new Set<string>();
  if (!graph) return result;
  const idSet = new Set(neighborhoodIds);
  for (const id of neighborhoodIds) {
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

/* ------------------------------------------------------------------------- *
 * Focus stack
 * ------------------------------------------------------------------------- */

/**
 * One level of the focus stack. Focusing a node from inside a focused view
 * PUSHES a frame, so focus mode is real graph exploration rather than a single
 * pinned neighborhood.
 *
 * The "edge" variant is fetched by `get_edge_detail` (feat/edge-drill-in); the
 * stack mechanics, breadcrumb trail and reducers below treat it generically and
 * never look inside a node frame's depth/direction unless the frame IS a node
 * frame.
 */
export type FocusFrame =
  | { type: "node"; nodeId: string; depth: 1 | 2; direction: FocusDirection }
  | { type: "edge"; source: string; target: string };

/** Construct a node frame (default 1 hop, bidirectional). */
export function nodeFrame(
  nodeId: string,
  depth: 1 | 2 = 1,
  direction: FocusDirection = "both"
): FocusFrame {
  return { type: "node", nodeId, depth, direction };
}

/**
 * A frame's identity for dedup/keying: the thing it focuses, NOT how it is
 * traced. Re-entering the same node at a different depth/direction is a
 * refinement of the current frame, not a new level.
 */
export function focusFrameKey(frame: FocusFrame): string {
  return frame.type === "node"
    ? `node:${frame.nodeId}`
    : `edge:${frame.source}->${frame.target}`;
}

/** The frame currently being rendered (top of stack), or null when unfocused. */
export function focusTopFrame(stack: readonly FocusFrame[]): FocusFrame | null {
  return stack.length === 0 ? null : stack[stack.length - 1];
}

/**
 * The node id of the top frame, or null when unfocused or when the top frame is
 * an edge frame (which focuses a relation, not a single node).
 */
export function focusTopNodeId(stack: readonly FocusFrame[]): string | null {
  const top = focusTopFrame(stack);
  return top !== null && top.type === "node" ? top.nodeId : null;
}

/** Whether any focus frame is active. */
export function focusIsActive(stack: readonly FocusFrame[]): boolean {
  return stack.length > 0;
}

/** Truncate a breadcrumb label to `max` characters, ellipsising the overflow. */
export function truncateLabel(label: string, max = 18): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

/**
 * Human-readable label for a breadcrumb chip: the node's name, or "A → B" for
 * an edge frame. `nameOf` resolves a node id to its display name (falling back
 * to the id itself for unknown nodes).
 */
export function focusFrameLabel(
  frame: FocusFrame,
  nameOf: (nodeId: string) => string
): string {
  if (frame.type === "node") return nameOf(frame.nodeId);
  return `${nameOf(frame.source)} → ${nameOf(frame.target)}`;
}

/**
 * Focus / view reducer state (the subset of graph store fields the two-view
 * model transitions operate on). Kept pure and framework-free so the transition
 * logic is unit-testable without the Tauri/zustand runtime.
 *
 * `focusStack` empty == unfocused; the last element is the frame on screen.
 */
export interface FocusViewState {
  viewMode: ViewMode;
  focusStack: FocusFrame[];
}

/**
 * Switching view mode. Entering module view always drops the ENTIRE focus stack
 * (module view has no symbol neighborhood); symbol view is left as-is.
 */
export function reduceSetViewMode(
  state: FocusViewState,
  mode: ViewMode
): FocusViewState {
  if (mode === "module") {
    return { ...state, viewMode: "module", focusStack: [] };
  }
  return { ...state, viewMode: "symbol" };
}

/**
 * Entering focus always drills into the symbol view and PUSHES a frame -- with
 * one exception: focusing the target of the CURRENT top frame replaces that
 * frame instead, so re-focusing what you are already looking at (or changing its
 * depth/direction) never stacks a duplicate.
 */
export function reduceEnterFocus(
  state: FocusViewState,
  frame: FocusFrame
): FocusViewState {
  const top = focusTopFrame(state.focusStack);
  const replacesTop = top !== null && focusFrameKey(top) === focusFrameKey(frame);
  const base = replacesTop ? state.focusStack.slice(0, -1) : state.focusStack;
  return { viewMode: "symbol", focusStack: [...base, frame] };
}

/**
 * Exiting focus (the breadcrumb X) clears the whole stack at once but leaves the
 * (symbol) view mode.
 */
export function reduceExitFocus(state: FocusViewState): FocusViewState {
  return { ...state, focusStack: [] };
}

/**
 * Popping ONE frame off the top (Esc). Focus ends only once the stack empties,
 * so Esc walks back out of a drill-down the way it walked in.
 */
export function reducePopFocus(state: FocusViewState): FocusViewState {
  if (state.focusStack.length === 0) return state;
  return { ...state, focusStack: state.focusStack.slice(0, -1) };
}

/**
 * Popping back to the breadcrumb frame at `index`, dropping every frame above
 * it. `index < 0` is the root ("All") chip and clears the stack. An index at or
 * beyond the top is a no-op.
 */
export function reducePopToFrame(
  state: FocusViewState,
  index: number
): FocusViewState {
  if (index < 0) return reduceExitFocus(state);
  if (index >= state.focusStack.length - 1) return state;
  return { ...state, focusStack: state.focusStack.slice(0, index + 1) };
}

/** Replace the top frame with `next`, or return `state` when there is no top. */
function replaceTopFrame(
  state: FocusViewState,
  next: (top: FocusFrame) => FocusFrame | null
): FocusViewState {
  const top = focusTopFrame(state.focusStack);
  if (top === null) return state;
  const replacement = next(top);
  if (replacement === null) return state;
  return {
    ...state,
    focusStack: [...state.focusStack.slice(0, -1), replacement],
  };
}

/**
 * Changing the hop depth of the CURRENT frame. Depth is per-frame: parent frames
 * keep the depth they were opened with. No-op when the top frame is not a node
 * frame (edge frames have no depth).
 */
export function reduceSetFocusDepth(
  state: FocusViewState,
  depth: 1 | 2
): FocusViewState {
  return replaceTopFrame(state, (top) =>
    top.type === "node" ? { ...top, depth } : null
  );
}

/**
 * Changing the trace direction of the CURRENT frame (callers / both / callees).
 * Per-frame, like depth; no-op on an edge frame.
 */
export function reduceSetFocusDirection(
  state: FocusViewState,
  direction: FocusDirection
): FocusViewState {
  return replaceTopFrame(state, (top) =>
    top.type === "node" ? { ...top, direction } : null
  );
}
