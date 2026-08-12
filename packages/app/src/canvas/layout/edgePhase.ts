import type { EdgeKind } from "../../api/types";
import { useDebugStore } from "../../stores/debugStore";
import type { LayoutResult } from "./layoutTypes";
import { rebuildEdges } from "./edgeRebuild.ts";
import { fetchViewEdges } from "./viewEdges";

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

export { rebuildEdges } from "./edgeRebuild.ts";

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
