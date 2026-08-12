import type { EdgeKind } from "../../api/types";
import type { LayoutEdge, LayoutResult } from "./layoutTypes";
import { straightLineEdge } from "./straightEdges.ts";
import type { ViewEdge } from "./viewEdges";

/**
 * The pure core of the edge-only layout phase: rebuild the view edges on a
 * previous layout's node positions, reusing routed geometry wherever the same
 * source/target/kind edge was already on screen and straight-lining edges that
 * appear anew.
 *
 * Every edge this produces must satisfy the drawing pass's contract (see
 * canvas-rendering): at least 2 points, with the endpoints anchored on the
 * source and target boxes. Cached edges inherit that from the layout that
 * routed them; new edges get it from `straightLineEdge`'s `anchorEdgePolyline`.
 *
 * Runtime imports use explicit `.ts` specifiers so this module (and its
 * `straightEdges` -> `edgeGeometry` chain) stays loadable under `node --test`.
 */

function edgeKey(source: string, target: string, kind: EdgeKind | null): string {
  return `${source}\u0000${target}\u0000${kind ?? ""}`;
}

/**
 * Index the previous layout's edges by identity. Parallel same-key edges are
 * kept in order and consumed one at a time, so each keeps its own route.
 */
function indexRoutedEdges(edges: LayoutEdge[]): Map<string, LayoutEdge[]> {
  const byKey = new Map<string, LayoutEdge[]>();
  for (const edge of edges) {
    const key = edgeKey(edge.source, edge.target, edge.kind);
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(edge);
    } else {
      byKey.set(key, [edge]);
    }
  }
  return byKey;
}

/** Rebuild the view edges on the previous layout's node positions. */
export function rebuildEdges(
  previous: LayoutResult,
  viewEdges: ViewEdge[]
): LayoutEdge[] {
  const routed = indexRoutedEdges(previous.edges);
  const edges: LayoutEdge[] = [];

  for (const ve of viewEdges) {
    const bucket = routed.get(edgeKey(ve.source, ve.target, ve.kind));
    const cached = bucket?.shift();
    if (cached) {
      // Same endpoints and kind: keep the routed polyline, take the fresh
      // count/resolution (aggregation can change with the fetched kind set).
      edges.push({
        ...cached,
        color: ve.color,
        count: ve.count,
        resolution: ve.resolution,
      });
      continue;
    }
    const fallback = straightLineEdge(previous.nodes, ve);
    if (fallback) edges.push(fallback);
  }

  return edges;
}
