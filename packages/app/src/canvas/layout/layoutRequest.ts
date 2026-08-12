import type { CodeGraph, EdgeKind } from "../../api/types";

/**
 * One unit of work for the renderer's layout pipeline.
 *
 * "full" re-solves the node-position problem with ELK and then fetches the view
 * edges; "edges" re-fetches/re-filters the view edges against the node positions
 * the last full layout produced. See `relayoutPolicy` for which state change
 * asks for which phase.
 */
export interface FullLayoutRequest {
  phase: "full";
  graph: CodeGraph;
  expandedNodes: Set<string>;
  visibleNodes: Set<string>;
  enabledEdgeKinds: Set<EdgeKind>;
  hideAmbiguousEdges: boolean;
}

export interface EdgeLayoutRequest {
  phase: "edges";
  enabledEdgeKinds: Set<EdgeKind>;
  hideAmbiguousEdges: boolean;
}

export type LayoutRequest = FullLayoutRequest | EdgeLayoutRequest;

/**
 * Coalesce two queued requests into one, so a burst of interactions costs a
 * single pass. A full layout dominates an edge phase (it recomputes the edges
 * anyway) but must adopt the newer edge filters; two requests of the same phase
 * keep the newer one.
 */
export function mergeLayoutRequests(
  pending: LayoutRequest,
  next: LayoutRequest
): LayoutRequest {
  if (next.phase === "full") return next;
  if (pending.phase === "full") {
    return {
      ...pending,
      enabledEdgeKinds: next.enabledEdgeKinds,
      hideAmbiguousEdges: next.hideAmbiguousEdges,
    };
  }
  return next;
}
