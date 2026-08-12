import type { EdgeKind, Resolution } from "../../api/types";
import { EDGE_COLORS } from "../../api/types";
import { getSubgraph } from "../../api/commands";
import { useDebugStore } from "../../stores/debugStore";
import {
  deriveEdgeKindCounts,
  unknownEdgeKindCounts,
  type EdgeKindCounts,
} from "../legend/edgeLegendModel";

/**
 * The "edges" half of the layout pipeline: fetch the per-view edges for a render
 * set from server-side graph state and turn them into display-ready view edges.
 *
 * Both phases go through here -- the ELK positions phase (which then routes
 * them) and the edge-only phase (which draws them against cached positions) --
 * so an edge-kind or hide-ambiguous toggle costs exactly this fetch and nothing
 * more.
 */

export const ALL_EDGE_KINDS: EdgeKind[] = [
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
];

/**
 * A view edge with resolved display info, ready to feed to ELK and extractLayout.
 * `kind` is null-safe: aggregated edges carry their exact kind (the backend
 * emits one aggregate per kind and pair, so parallel same-pair view edges of
 * different kinds are expected); `count` drives tooltip counts and edge-width
 * scaling. `resolution` is null for aggregated edges (no single confidence) and
 * carries the direct edge's confidence otherwise (drives ambiguous styling).
 */
export interface ViewEdge {
  source: string;
  target: string;
  color: string;
  kind: EdgeKind | null;
  count: number;
  resolution: Resolution | null;
}

export interface ViewEdgeSet {
  viewEdges: ViewEdge[];
  /** Per-kind counts for the legend, derived from the same payload. */
  edgeKindCounts: EdgeKindCounts;
}

/**
 * Fetch and build the view edges for a render set. A failed fetch yields an
 * empty edge set with unknown counts rather than throwing, so the layout still
 * renders its nodes.
 */
export async function fetchViewEdges(
  renderIds: string[],
  enabledEdgeKinds: Set<EdgeKind> | undefined,
  hideAmbiguousEdges: boolean
): Promise<ViewEdgeSet> {
  const enabledKinds = enabledEdgeKinds
    ? Array.from(enabledEdgeKinds)
    : ALL_EDGE_KINDS;

  const viewEdges: ViewEdge[] = [];
  try {
    const sub = await getSubgraph(renderIds, enabledKinds);
    const edgeKindCounts = deriveEdgeKindCounts(
      sub,
      enabledKinds,
      hideAmbiguousEdges
    );
    for (const e of sub.edges) {
      // Ambiguous direct edges can be hidden client-side (imports are exact so
      // this only ever affects reference edges).
      if (hideAmbiguousEdges && e.resolution === "Ambiguous") continue;
      viewEdges.push({
        source: e.source,
        target: e.target,
        color: EDGE_COLORS[e.kind] || "#64748b",
        kind: e.kind,
        count: e.weight,
        resolution: e.resolution,
      });
    }
    for (const ae of sub.aggregated_edges) {
      viewEdges.push({
        source: ae.source,
        target: ae.target,
        color: EDGE_COLORS[ae.kind] || "#64748b",
        kind: ae.kind,
        count: ae.count,
        resolution: null,
      });
    }
    return { viewEdges, edgeKindCounts };
  } catch (err) {
    console.error("getSubgraph failed:", err);
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`getSubgraph FAILED: ${err}`);
    }
    return { viewEdges: [], edgeKindCounts: unknownEdgeKindCounts() };
  }
}
