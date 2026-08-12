import type { EdgeKind } from "../../api/types";
import { useDebugStore } from "../../stores/debugStore";
import type { LayoutEdge, LayoutResult } from "./layoutTypes";
import { straightLineEdge } from "./straightEdges";
import { fetchViewEdges, type ViewEdge } from "./viewEdges";

/**
 * The edge-only layout phase.
 *
 * Edge-kind and hide-ambiguous toggles change WHICH edges are shown, not where
 * the nodes are, so they re-run this phase instead of a full ELK layout: one
 * `get_subgraph` fetch against the previous layout's render set, then edges
 * rebuilt on the previous layout's node positions.
 *
 * Routed geometry is reused wherever the same source/target/kind edge was
 * already on screen, so the common "filter down" direction (turning a kind off,
 * hiding ambiguous edges) keeps ELK's orthogonal routes exactly as they were.
 * Edges that appear for the first time get a straight connector until the next
 * full layout re-routes them.
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

/**
 * Rebuild the view edges on the previous layout's node positions. Exported for
 * clarity of the phase seam; `layoutEdgePhase` is the entry point.
 */
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

/**
 * Re-fetch and rebuild the view edges for the last laid-out render set, keeping
 * every node position. Never touches ELK.
 */
export async function layoutEdgePhase(
  previous: LayoutResult,
  enabledEdgeKinds: Set<EdgeKind> | undefined,
  hideAmbiguousEdges: boolean
): Promise<LayoutResult> {
  const { viewEdges, edgeKindCounts } = await fetchViewEdges(
    previous.renderIds,
    enabledEdgeKinds,
    hideAmbiguousEdges
  );

  const edges = rebuildEdges(previous, viewEdges);

  if (import.meta.env.DEV) {
    useDebugStore
      .getState()
      .addLog(
        `Edge phase: viewEdges=${viewEdges.length}, drawn=${edges.length}, positions reused=${Object.keys(previous.nodes).length}`
      );
  }

  return {
    nodes: previous.nodes,
    edges,
    edgeKindCounts,
    renderIds: previous.renderIds,
  };
}
