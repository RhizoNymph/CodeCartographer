/**
 * The pure half of the ELK positions phase: turning an `ElkNode` tree that came
 * back from the worker into node positions and routed `LayoutEdge`s.
 *
 * Split out of `elkLayout.ts` so it can be exercised without the elkjs worker:
 * everything here is a plain function over plain data. `elkLayout` keeps the
 * side-effecting parts -- running ELK, the DEV debug log, the straight-line and
 * grid fallbacks.
 *
 * ELK's own types are imported TYPE-ONLY, and runtime imports use explicit `.ts`
 * specifiers, so this module loads under `node --test`.
 */

import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import {
  anchorEdgePolyline,
  dedupePolylinePoints,
  edgeAnchorAtBoundary,
  type Point,
} from "./edgeGeometry.ts";
import { elkEdgeIndex } from "./elkEdgeId.ts";
import type { LayoutEdge, LayoutNodePosition } from "./layoutTypes";
import type { ViewEdge } from "./viewEdges";

/** Counts the DEV debug log reports about one extraction. */
export interface ExtractStats {
  /** ELK edges seen anywhere in the tree. */
  totalEdgesFound: number;
  /** ...of which ELK actually routed (they carry `sections`). */
  edgesWithSections: number;
  /** ...of which fell back to a centre-to-centre connector. */
  edgesWithoutSections: number;
}

export interface RoutedEdgeExtraction {
  edges: LayoutEdge[];
  stats: ExtractStats;
}

/** Absolute position of every node in the tree, root excluded. */
export function extractNodePositions(
  root: ElkNode
): Record<string, LayoutNodePosition> {
  const positions: Record<string, LayoutNodePosition> = {};

  function walk(node: ElkNode, offsetX: number, offsetY: number): void {
    const x = offsetX + (node.x || 0);
    const y = offsetY + (node.y || 0);

    if (node.id !== "root") {
      positions[node.id] = {
        x,
        y,
        width: node.width || 100,
        height: node.height || 40,
      };
    }

    if (node.children) {
      for (const child of node.children) {
        walk(child, x, y);
      }
    }
  }

  walk(root, 0, 0);
  return positions;
}

/**
 * One ELK edge's polyline in absolute coordinates.
 *
 * Section coordinates are relative to the node the edge is STORED on, so the
 * caller passes that node's absolute offset. An edge ELK declined to route has
 * no sections; it falls back to a centre-to-centre connector, and yields an
 * empty polyline when either endpoint is missing a position.
 */
export function elkEdgePolyline(
  edge: ElkExtendedEdge,
  offsetX: number,
  offsetY: number,
  positions: Record<string, LayoutNodePosition>
): Point[] {
  const points: Point[] = [];

  if (edge.sections) {
    for (const section of edge.sections) {
      points.push({
        x: offsetX + section.startPoint.x,
        y: offsetY + section.startPoint.y,
      });
      if (section.bendPoints) {
        for (const bend of section.bendPoints) {
          points.push({ x: offsetX + bend.x, y: offsetY + bend.y });
        }
      }
      points.push({
        x: offsetX + section.endPoint.x,
        y: offsetY + section.endPoint.y,
      });
    }
    return points;
  }

  const sourcePos = positions[edge.sources[0]];
  const targetPos = positions[edge.targets[0]];
  if (sourcePos && targetPos) {
    points.push({
      x: sourcePos.x + sourcePos.width / 2,
      y: sourcePos.y + sourcePos.height / 2,
    });
    points.push({
      x: targetPos.x + targetPos.width / 2,
      y: targetPos.y + targetPos.height / 2,
    });
  }

  return points;
}

/**
 * Turn one ELK edge into a `LayoutEdge`, or null when it cannot become a
 * drawable, anchored polyline.
 *
 * This is where an edge's anchors are DECIDED, exactly once, from the pristine
 * route: `edgeAnchorAtBoundary` reads the side off the first/last segment's
 * direction, and `anchorEdgePolyline` then makes the geometry agree with them.
 * Everything downstream -- the edges phase, the draw-time route pipeline --
 * consumes the anchors recorded here instead of re-deriving them.
 */
export function routedEdgeFromElk(
  edge: ElkExtendedEdge,
  offsetX: number,
  offsetY: number,
  positions: Record<string, LayoutNodePosition>,
  viewEdges: readonly ViewEdge[]
): LayoutEdge | null {
  const sourceId = edge.sources[0];
  const targetId = edge.targets[0];

  const points = elkEdgePolyline(edge, offsetX, offsetY, positions);
  if (points.length < 2) {
    return null;
  }

  const sourcePos = positions[sourceId];
  const targetPos = positions[targetId];
  if (!sourcePos || !targetPos) {
    return null;
  }

  const normalizedPoints = dedupePolylinePoints(points);
  if (normalizedPoints.length < 2) {
    return null;
  }

  // Resolve by the index encoded in the edge id, not by endpoint pair:
  // parallel edges between the same pair (e.g. per-kind aggregates) must each
  // keep their own kind/color/count.
  const index = elkEdgeIndex(edge.id);
  const info = index !== null ? viewEdges[index] : undefined;

  const sourceAnchor = edgeAnchorAtBoundary(
    sourcePos,
    normalizedPoints[0],
    normalizedPoints[1]
  );
  const targetAnchor = edgeAnchorAtBoundary(
    targetPos,
    normalizedPoints[normalizedPoints.length - 1],
    normalizedPoints[normalizedPoints.length - 2]
  );

  return {
    source: sourceId,
    target: targetId,
    color: info?.color ?? "#64748b",
    kind: info?.kind ?? null,
    count: info?.count ?? 1,
    resolution: info?.resolution ?? null,
    points: anchorEdgePolyline(
      normalizedPoints,
      sourcePos,
      targetPos,
      sourceAnchor,
      targetAnchor
    ).points,
    sourceAnchor,
    targetAnchor,
  };
}

/**
 * Every routed edge in the tree, in ELK's own traversal order.
 *
 * Walks the tree a second time (after `extractNodePositions`) because an edge's
 * section coordinates are relative to the node it hangs off, so the walk has to
 * carry that node's absolute offset.
 */
export function extractRoutedEdges(
  root: ElkNode,
  positions: Record<string, LayoutNodePosition>,
  viewEdges: readonly ViewEdge[]
): RoutedEdgeExtraction {
  const edges: LayoutEdge[] = [];
  const stats: ExtractStats = {
    totalEdgesFound: 0,
    edgesWithSections: 0,
    edgesWithoutSections: 0,
  };

  function walk(node: ElkNode, offsetX: number, offsetY: number): void {
    const x = offsetX + (node.x || 0);
    const y = offsetY + (node.y || 0);

    if (node.children) {
      for (const child of node.children) {
        walk(child, x, y);
      }
    }

    if (!node.edges) {
      return;
    }

    stats.totalEdgesFound += node.edges.length;

    for (const edge of node.edges) {
      if (edge.sections) {
        stats.edgesWithSections++;
      } else {
        stats.edgesWithoutSections++;
      }

      const routed = routedEdgeFromElk(edge, x, y, positions, viewEdges);
      if (routed) {
        edges.push(routed);
      }
    }
  }

  walk(root, 0, 0);
  return { edges, stats };
}
