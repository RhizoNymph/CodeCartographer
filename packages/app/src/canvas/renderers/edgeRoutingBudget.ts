/**
 * Budget gate for the client-side edge re-routing pass.
 *
 * Obstacle re-routing is the most expensive thing the renderer does: every edge
 * runs up to `MAX_OBSTACLE_REROUTE_PASSES` detour passes, and the crossing-aware
 * candidate scoring additionally compares each candidate against every polyline
 * routed so far -- that last part is O(E^2) and is what makes a large view look
 * hung. Rather than let it run unbounded, the redraw picks a MODE up front from
 * the amount of work in front of it.
 *
 * Pure and dependency-free (type-only imports elsewhere), so it loads under
 * `node --test`.
 */

/**
 * How much routing a redraw can afford.
 *
 * - `full`: detour around obstacles AND score candidate detours by how many
 *   already-routed edges they cross (the prettiest, most expensive result).
 * - `obstacles`: detour around obstacles, but score candidates on obstacle
 *   crossings and length only -- the O(E^2) inter-edge comparison is dropped.
 * - `none`: draw the polyline the layout produced. No detours at all.
 */
export type EdgeRoutingMode = "full" | "obstacles" | "none";

/**
 * Above this many rendered edges the inter-edge crossing score is dropped.
 *
 * The score is quadratic in the number of already-routed polylines, so its cost
 * grows ~E^2/2 segment-pair comparisons; at a few hundred edges that is already
 * millions of comparisons per redraw, and the aesthetic gain is invisible in a
 * view that dense.
 */
export const CROSSING_AWARE_EDGE_LIMIT = 250;

/**
 * Above this many rendered edges obstacle re-routing is skipped entirely.
 *
 * ELK has already routed these edges orthogonally; the client pass only cleans
 * up after node drags and label overlaps. Past ~500 edges the view reads as a
 * hairball regardless, so the pass buys nothing and costs everything.
 */
export const OBSTACLE_ROUTING_EDGE_LIMIT = 500;

/**
 * Above this many visible nodes obstacle re-routing is skipped regardless of
 * edge count: the obstacle set (one body box plus one label box per node) is
 * what each detour pass filters over, so a huge node count is expensive even
 * for a handful of edges.
 */
export const OBSTACLE_ROUTING_NODE_LIMIT = 2000;

export interface EdgeRoutingBudgetInput {
  /** Edges that will actually be stroked this redraw (post visibility + LOD filtering). */
  renderedEdges: number;
  /** Nodes contributing obstacle boxes this redraw. */
  visibleNodes: number;
  /**
   * False when the current LOD renders edges fully transparent, in which case
   * routing them is pure waste. Defaults to true.
   */
  edgesVisible?: boolean;
}

/**
 * Routing mode for a redraw. Monotonically non-increasing in both counts: more
 * work in front of us never buys a more expensive mode.
 */
export function resolveEdgeRoutingMode(input: EdgeRoutingBudgetInput): EdgeRoutingMode {
  const { renderedEdges, visibleNodes, edgesVisible = true } = input;

  if (!edgesVisible || renderedEdges <= 0) {
    return "none";
  }

  if (
    renderedEdges > OBSTACLE_ROUTING_EDGE_LIMIT ||
    visibleNodes > OBSTACLE_ROUTING_NODE_LIMIT
  ) {
    return "none";
  }

  if (renderedEdges > CROSSING_AWARE_EDGE_LIMIT) {
    return "obstacles";
  }

  return "full";
}

/**
 * Above this many nodes in the render set, ELK's own orthogonal edge routing is
 * skipped and straight-line fallback edges are used instead.
 */
export const LAYOUT_EDGE_ROUTING_NODE_LIMIT = 1500;

/**
 * Above this many view edges, ELK edge routing is skipped regardless of node
 * count. Routing cost is driven by EDGES, not nodes: a 1400-node view carrying
 * 20k edges used to sail past a node-only guard and then take minutes.
 */
export const LAYOUT_EDGE_ROUTING_EDGE_LIMIT = 3000;

/**
 * Whether the layout pass should skip ELK edge routing for a view of this size.
 */
export function shouldSkipLayoutEdgeRouting(
  renderNodeCount: number,
  viewEdgeCount: number
): boolean {
  return (
    renderNodeCount > LAYOUT_EDGE_ROUTING_NODE_LIMIT ||
    viewEdgeCount > LAYOUT_EDGE_ROUTING_EDGE_LIMIT
  );
}

/** Whether this mode detours edges around node/label boxes at all. */
export function routesAroundObstacles(mode: EdgeRoutingMode): boolean {
  return mode !== "none";
}

/** Whether this mode scores detour candidates against already-routed edges. */
export function scoresEdgeCrossings(mode: EdgeRoutingMode): boolean {
  return mode === "full";
}
