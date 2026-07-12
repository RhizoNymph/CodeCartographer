import type { CodeGraph, CodeNode, EdgeKind } from "../api/types";

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

/**
 * Focus / view reducer state (the subset of graph store fields the two-view
 * model transitions operate on). Kept pure and framework-free so the transition
 * logic is unit-testable without the Tauri/zustand runtime.
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
