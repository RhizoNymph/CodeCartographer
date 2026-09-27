// Explicit .ts specifier keeps this module loadable under `node --test`
// (see edgeRebuild.ts and its seam test).
import {
  anchorEdgePolyline,
  type EdgeAnchor,
  type Point,
} from "./edgeGeometry.ts";
import type { LayoutEdge, LayoutNodePosition } from "./layoutTypes";
import type { ViewEdge } from "./viewEdges";

/**
 * Straight-line edge geometry against known node positions.
 *
 * Used in three places: when ELK routed nothing, when routing was skipped for a
 * very large view, and by the edge-only phase for edges that appear without a
 * cached route (a newly enabled edge kind).
 */

/**
 * A single straight connector between two laid-out nodes, anchored to the
 * facing sides. Returns null when either endpoint has no position.
 */
export function straightLineEdge(
  nodes: Record<string, LayoutNodePosition>,
  edge: ViewEdge
): LayoutEdge | null {
  const sourcePos = nodes[edge.source];
  const targetPos = nodes[edge.target];
  if (!sourcePos || !targetPos) return null;

  const sourceCx = sourcePos.x + sourcePos.width / 2;
  const sourceCy = sourcePos.y + sourcePos.height / 2;
  const targetCx = targetPos.x + targetPos.width / 2;
  const targetCy = targetPos.y + targetPos.height / 2;

  const dx = targetCx - sourceCx;
  const dy = targetCy - sourceCy;

  let startPoint: Point;
  let endPoint: Point;
  // The anchors are not read back off the geometry: this function CHOOSES the
  // facing sides, so it states them outright. Mid-side offsets by construction.
  let sourceAnchor: EdgeAnchor;
  let targetAnchor: EdgeAnchor;

  if (Math.abs(dx) > Math.abs(dy)) {
    startPoint = {
      x: dx > 0 ? sourcePos.x + sourcePos.width : sourcePos.x,
      y: sourceCy,
    };
    endPoint = {
      x: dx > 0 ? targetPos.x : targetPos.x + targetPos.width,
      y: targetCy,
    };
    sourceAnchor = {
      side: dx > 0 ? "right" : "left",
      offset: sourcePos.height / 2,
    };
    targetAnchor = {
      side: dx > 0 ? "left" : "right",
      offset: targetPos.height / 2,
    };
  } else {
    startPoint = {
      x: sourceCx,
      y: dy > 0 ? sourcePos.y + sourcePos.height : sourcePos.y,
    };
    endPoint = {
      x: targetCx,
      y: dy > 0 ? targetPos.y : targetPos.y + targetPos.height,
    };
    sourceAnchor = {
      side: dy > 0 ? "bottom" : "top",
      offset: sourcePos.width / 2,
    };
    targetAnchor = {
      side: dy > 0 ? "top" : "bottom",
      offset: targetPos.width / 2,
    };
  }

  return {
    source: edge.source,
    target: edge.target,
    color: edge.color,
    kind: edge.kind,
    count: edge.count,
    resolution: edge.resolution,
    points: anchorEdgePolyline(
      [startPoint, endPoint],
      sourcePos,
      targetPos,
      sourceAnchor,
      targetAnchor
    ).points,
    sourceAnchor,
    targetAnchor,
  };
}

/** Straight connectors for every view edge whose endpoints are laid out. */
export function straightLineEdges(
  nodes: Record<string, LayoutNodePosition>,
  viewEdges: ViewEdge[]
): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  for (const ve of viewEdges) {
    const edge = straightLineEdge(nodes, ve);
    if (edge) edges.push(edge);
  }
  return edges;
}
