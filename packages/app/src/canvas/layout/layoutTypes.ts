import type { EdgeKind, Resolution } from "../../api/types";
import type { EdgeKindCounts } from "../legend/edgeLegendModel";
import type { EdgeAnchor, Point } from "./edgeGeometry";

/**
 * Shared result types for the two layout phases (ELK positions phase and the
 * edge-only phase). Kept in their own type-only module so both phases -- and the
 * renderer -- can depend on them without importing the elkjs worker.
 */

export interface LayoutNodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
  color: string;
  kind: EdgeKind | null; // null when the underlying kind is unknown
  /** Number of underlying edges (1 for direct, N for aggregated). Drives tooltip count + width. */
  count: number;
  /** Resolution confidence for direct edges; null for aggregated edges. */
  resolution: Resolution | null;
  points: Point[];
  sourceAnchor: EdgeAnchor;
  targetAnchor: EdgeAnchor;
}

export interface LayoutResult {
  nodes: Record<string, LayoutNodePosition>;
  edges: LayoutEdge[];
  /**
   * Underlying edge counts per kind for this view, derived from the fetched
   * `SubGraph`. Kinds that were not requested are `null` (unknown). Published to
   * `edgeLegendStore` by the renderer once the layout is known to be current.
   */
  edgeKindCounts: EdgeKindCounts;
  /**
   * The ids that were actually laid out (visible nodes whose ancestors are all
   * expanded) -- the render set sent to `get_subgraph`. The edge-only phase
   * re-fetches against exactly this set, so it needs no ELK tree of its own.
   */
  renderIds: string[];
}
