import { Container, Graphics } from "pixi.js";
import type { EdgeKind } from "../../api/types";
import {
  anchorEdgePolyline,
  inferEdgeAnchor,
  inferEdgeAnchorFromPoint,
  rerouteOrthogonalEdge,
  routePolylineAroundObstacles,
  translatePolyline,
  type EdgeAnchor,
  type NodeBox,
  type Point,
} from "../layout/edgeGeometry";
import {
  ObstacleIndex,
  obstacleEntry,
  type ObstacleEntry,
} from "../layout/obstacleIndex";
import type { LayoutResult } from "../layout/elkLayout";
import { useViewportStore, type LODLevel } from "../../stores/viewportStore";
import {
  EDGE_STYLES,
  DEFAULT_EDGE_STYLE,
  type EdgeDatum,
  type NodeDisplayRef,
} from "./types";
import {
  resolveEdgeRoutingMode,
  routesAroundObstacles,
  scoresEdgeCrossings,
} from "./edgeRoutingBudget";
import {
  buildEdgeCountChipLayer,
  polylineArcMidpoint,
  shouldShowCountChip,
  type EdgeCountChipSpec,
} from "./edgeLabels";

// Re-export types for backwards compatibility with existing imports
export type { EdgeDatum, NodeDisplayRef } from "./types";

/**
 * How far beyond an edge's own bounding box obstacles are still considered.
 *
 * The router may leave the corridor between the endpoints: a detour clears an
 * obstacle inflated by `NODE_OBSTACLE_MARGIN` (14) and can be pushed a further
 * `DETOUR_GUTTER` (28) outside the boxes it goes around, on top of a node's own
 * height. 160 layout units covers that with room to spare while keeping each
 * query to a handful of boxes instead of the whole graph.
 */
const OBSTACLE_QUERY_MARGIN = 160;

/** Shared empty reference list, so the no-scoring path allocates nothing. */
const NO_REFERENCE_POLYLINES: Point[][] = [];

interface ResolvedEdgeDraw {
  index: number;
  edge: EdgeDatum;
  points: Point[];
  sourceBox: NodeBox;
  targetBox: NodeBox;
}

/**
 * "#64748b" -> 0x64748b. Done once per edge per LAYOUT (in `buildEdgeData`)
 * rather than once per edge per REDRAW, which is where it used to sit.
 */
function parseEdgeColor(color: string): number {
  const parsed = parseInt(color.replace("#", ""), 16);
  return Number.isNaN(parsed) ? 0x64748b : parsed;
}

function getBoxCenter(box: NodeBox): Point {
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function nearlyEqual(a: number, b: number, tolerance = 1.5): boolean {
  return Math.abs(a - b) <= tolerance;
}

function boxContainsPoint(box: NodeBox, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

function nodeRefToBox(ref: NodeDisplayRef): NodeBox {
  return {
    x: ref.containerX,
    y: ref.containerY,
    width: ref.layoutWidth,
    height: ref.layoutHeight,
  };
}

function nodeRefToLabelObstacle(ref: NodeDisplayRef): NodeBox | null {
  if (!ref.labelVisible || ref.nodeType === "CodeBlock" || ref.labelWidth <= 0 || ref.labelHeight <= 0) {
    return null;
  }

  const paddingX = 8;
  const paddingY = 6;
  const localX = Math.max(0, ref.labelX - paddingX);
  const localY = Math.max(0, ref.labelY - paddingY);
  const maxWidth = Math.max(0, ref.layoutWidth - localX);
  const maxHeight = Math.max(0, ref.layoutHeight - localY);
  const width = Math.min(maxWidth, ref.labelWidth + paddingX * 2);
  const height = Math.min(maxHeight, ref.labelHeight + paddingY * 2);

  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x: ref.containerX + localX,
    y: ref.containerY + localY,
    width,
    height,
  };
}

function inferPointSide(box: NodeBox, point: Point): EdgeAnchor["side"] | null {
  if (nearlyEqual(point.x, box.x)) return "left";
  if (nearlyEqual(point.x, box.x + box.width)) return "right";
  if (nearlyEqual(point.y, box.y)) return "top";
  if (nearlyEqual(point.y, box.y + box.height)) return "bottom";
  return null;
}

function sideLength(box: NodeBox, side: EdgeAnchor["side"]): number {
  return side === "left" || side === "right" ? box.height : box.width;
}

function pointOnSide(box: NodeBox, side: EdgeAnchor["side"], offset: number): Point {
  const clampedOffset = Math.max(0, Math.min(sideLength(box, side), offset));

  switch (side) {
    case "left":
      return { x: box.x, y: box.y + clampedOffset };
    case "right":
      return { x: box.x + box.width, y: box.y + clampedOffset };
    case "top":
      return { x: box.x + clampedOffset, y: box.y };
    case "bottom":
      return { x: box.x + clampedOffset, y: box.y + box.height };
  }
}

function laneOffset(box: NodeBox, side: EdgeAnchor["side"], index: number, count: number): number {
  const length = sideLength(box, side);
  if (count <= 1) {
    return length / 2;
  }

  const padding = Math.min(12, Math.max(4, length / 4));
  const usable = Math.max(1, length - padding * 2);
  return padding + (usable * (index + 1)) / (count + 1);
}

function orderValueForSide(box: NodeBox, side: EdgeAnchor["side"]): number {
  const center = getBoxCenter(box);
  return side === "left" || side === "right" ? center.y : center.x;
}

function moveEndpointToLane(
  points: Point[],
  box: NodeBox,
  side: EdgeAnchor["side"],
  offset: number,
  atEnd: boolean
): Point[] {
  if (points.length < 2) {
    return points;
  }

  const nextPoints = points.map((point) => ({ ...point }));
  const endpoint = pointOnSide(box, side, offset);

  if (atEnd) {
    const prevIndex = nextPoints.length - 2;
    nextPoints[nextPoints.length - 1] = endpoint;

    if (side === "left" || side === "right") {
      nextPoints[prevIndex] = { ...nextPoints[prevIndex], y: endpoint.y };
    } else {
      nextPoints[prevIndex] = { ...nextPoints[prevIndex], x: endpoint.x };
    }
  } else {
    nextPoints[0] = endpoint;

    if (side === "left" || side === "right") {
      nextPoints[1] = { ...nextPoints[1], y: endpoint.y };
    } else {
      nextPoints[1] = { ...nextPoints[1], x: endpoint.x };
    }
  }

  return routePolylineAroundObstacles(nextPoints, []);
}

function spreadEndpointLanes(draws: ResolvedEdgeDraw[], atEnd: boolean): void {
  const groups = new Map<string, ResolvedEdgeDraw[]>();

  for (const draw of draws) {
    const box = atEnd ? draw.targetBox : draw.sourceBox;
    const point = atEnd ? draw.points[draw.points.length - 1] : draw.points[0];
    const side = inferPointSide(box, point);

    if (!side) {
      continue;
    }

    const nodeId = atEnd ? draw.edge.target : draw.edge.source;
    const key = `${nodeId}:${side}`;
    const group = groups.get(key);

    if (group) {
      group.push(draw);
    } else {
      groups.set(key, [draw]);
    }
  }

  for (const group of groups.values()) {
    if (group.length <= 1) {
      continue;
    }

    const side = inferPointSide(
      atEnd ? group[0].targetBox : group[0].sourceBox,
      atEnd ? group[0].points[group[0].points.length - 1] : group[0].points[0]
    );
    if (!side) {
      continue;
    }

    group.sort((a, b) => {
      const aBox = atEnd ? a.sourceBox : a.targetBox;
      const bBox = atEnd ? b.sourceBox : b.targetBox;
      return orderValueForSide(aBox, side) - orderValueForSide(bBox, side);
    });

    for (let i = 0; i < group.length; i++) {
      const draw = group[i];
      const box = atEnd ? draw.targetBox : draw.sourceBox;
      draw.points = moveEndpointToLane(
        draw.points,
        box,
        side,
        laneOffset(box, side, i, group.length),
        atEnd
      );
    }
  }
}

function inferAnchorsFromPolyline(
  points: Point[],
  sourceBox: NodeBox,
  targetBox: NodeBox
): { sourceAnchor: EdgeAnchor; targetAnchor: EdgeAnchor } {
  const sourceAnchor =
    points.length >= 2
      ? inferEdgeAnchor(sourceBox, points[0], points[1])
      : inferEdgeAnchorFromPoint(sourceBox, getBoxCenter(targetBox));
  const targetAnchor =
    points.length >= 2
      ? inferEdgeAnchor(
          targetBox,
          points[points.length - 1],
          points[points.length - 2]
        )
      : inferEdgeAnchorFromPoint(targetBox, getBoxCenter(sourceBox));

  return { sourceAnchor, targetAnchor };
}

/**
 * Snapshot every visible node's display ref ONCE per redraw.
 *
 * This used to happen per edge (`getNodeDisplayRef` inside the obstacle loop),
 * which allocated one fresh 12-field object per node PER EDGE -- O(E x N)
 * allocations. Now each node is read exactly once and every edge shares the
 * result.
 */
function snapshotNodeRefs(
  visibleNodes: Set<string>,
  getNodeDisplayRef: (nodeId: string) => NodeDisplayRef | null
): Map<string, NodeDisplayRef> {
  const refs = new Map<string, NodeDisplayRef>();

  for (const nodeId of visibleNodes) {
    const ref = getNodeDisplayRef(nodeId);
    if (ref) {
      refs.set(nodeId, ref);
    }
  }

  return refs;
}

/**
 * Index every obstacle box (node body + label) for one redraw.
 *
 * Boxes are tagged with their node id so an edge can drop the ones belonging to
 * its own endpoints in a single query.
 */
function buildObstacleIndex(refs: ReadonlyMap<string, NodeDisplayRef>): ObstacleIndex {
  const entries: ObstacleEntry[] = [];

  for (const [nodeId, ref] of refs) {
    const labelObstacle = nodeRefToLabelObstacle(ref);
    if (labelObstacle) {
      entries.push(obstacleEntry(nodeId, labelObstacle));
    }
    entries.push(obstacleEntry(nodeId, nodeRefToBox(ref)));
  }

  return new ObstacleIndex(entries);
}

/**
 * Obstacles one edge actually has to care about: the boxes near its polyline,
 * minus its own endpoints' boxes and minus any box that swallows an endpoint
 * centre (a collapsed container holding one of the endpoints -- routing around
 * it is impossible, and trying produces long useless detours).
 */
function obstaclesForEdge(index: ObstacleIndex, draw: ResolvedEdgeDraw): NodeBox[] {
  const candidates = index.queryForPolyline(
    draw.points,
    OBSTACLE_QUERY_MARGIN,
    draw.edge.source,
    draw.edge.target
  );

  if (candidates.length === 0) {
    return candidates;
  }

  const sourceCenter = getBoxCenter(draw.sourceBox);
  const targetCenter = getBoxCenter(draw.targetBox);
  const obstacles: NodeBox[] = [];

  for (const box of candidates) {
    if (boxContainsPoint(box, sourceCenter) || boxContainsPoint(box, targetCenter)) {
      continue;
    }
    obstacles.push(box);
  }

  return obstacles;
}

/**
 * Resolves edge routing points for a single edge given current node positions.
 * Extracted so both base and highlight layers can share this logic.
 *
 * Obstacle avoidance is NOT done here -- it is a separate, budget-gated pass
 * over the resolved draws (see `redrawEdgesWithHighlight`).
 */
function resolveEdgeDraw(
  index: number,
  edge: EdgeDatum,
  refs: ReadonlyMap<string, NodeDisplayRef>
): ResolvedEdgeDraw | null {
  const sourceRef = refs.get(edge.source);
  const targetRef = refs.get(edge.target);

  if (!sourceRef || !targetRef || edge.originalPoints.length < 2) return null;

  const sourceBox = {
    x: sourceRef.containerX,
    y: sourceRef.containerY,
    width: sourceRef.layoutWidth,
    height: sourceRef.layoutHeight,
  };
  const targetBox = {
    x: targetRef.containerX,
    y: targetRef.containerY,
    width: targetRef.layoutWidth,
    height: targetRef.layoutHeight,
  };
  const sourceDx = sourceRef.containerX - sourceRef.layoutX;
  const sourceDy = sourceRef.containerY - sourceRef.layoutY;
  const targetDx = targetRef.containerX - targetRef.layoutX;
  const targetDy = targetRef.containerY - targetRef.layoutY;
  const sourceMoved = Math.abs(sourceDx) > 1 || Math.abs(sourceDy) > 1;
  const targetMoved = Math.abs(targetDx) > 1 || Math.abs(targetDy) > 1;

  let points: Point[];
  if (!sourceMoved && !targetMoved) {
    const anchors = inferAnchorsFromPolyline(edge.originalPoints, sourceBox, targetBox);
    points = anchorEdgePolyline(
      edge.originalPoints,
      sourceBox,
      targetBox,
      anchors.sourceAnchor,
      anchors.targetAnchor
    );
  } else if (
    Math.abs(sourceDx - targetDx) <= 1 &&
    Math.abs(sourceDy - targetDy) <= 1
  ) {
    const translatedPoints = translatePolyline(
      edge.originalPoints,
      (sourceDx + targetDx) / 2,
      (sourceDy + targetDy) / 2
    );
    const anchors = inferAnchorsFromPolyline(translatedPoints, sourceBox, targetBox);
    points = anchorEdgePolyline(
      translatedPoints,
      sourceBox,
      targetBox,
      anchors.sourceAnchor,
      anchors.targetAnchor
    );
  } else {
    const sourceAnchor = inferEdgeAnchorFromPoint(sourceBox, getBoxCenter(targetBox));
    const targetAnchor = inferEdgeAnchorFromPoint(targetBox, getBoxCenter(sourceBox));
    points = rerouteOrthogonalEdge(
      edge.originalPoints,
      sourceBox,
      targetBox,
      sourceAnchor,
      targetAnchor
    );
  }

  return points.length >= 2
    ? { index, edge, points, sourceBox, targetBox }
    : null;
}

/**
 * Draw a single edge (path + start cap + arrowhead) into a Graphics object.
 *
 * When `dashed` is true (used for ambiguous, low-confidence edges) the path is
 * drawn as a dashed polyline instead of the continuous rounded path.
 */
function renderSingleEdge(
  gfx: Graphics,
  points: Point[],
  color: number,
  alpha: number,
  width: number,
  showStartCap: boolean,
  dashed = false
): void {
  // Degenerate polylines (routing can collapse edges whose endpoints coincide,
  // e.g. mid-drag) cannot be stroked and would crash the arrowhead indexing.
  if (points.length < 2) {
    return;
  }

  if (dashed) {
    drawDashedPolyline(gfx, points, DASH_LENGTH, DASH_GAP);
  } else {
    drawEdgePath(gfx, points, Math.max(4, width * 2.2));
  }
  gfx.stroke({
    color,
    width,
    alpha,
    cap: "round",
    join: "round",
  });

  if (showStartCap) {
    drawEdgeStartCap(gfx, points[0], color, alpha, width);
  }

  drawEdgeArrowhead(
    gfx,
    points[points.length - 2],
    points[points.length - 1],
    color,
    alpha,
    width
  );
}

/**
 * Manages all edge-related rendering using a two-layer architecture:
 *
 * - **baseLayer**: contains ALL edges drawn at normal LOD-based opacity.
 *   Rebuilt on layout change, visibility change, LOD change, or drag.
 *
 * - **highlightLayer**: contains ONLY the highlighted edges at full opacity.
 *   Rebuilt whenever the highlight changes (hover or pinned selection).
 *
 * On a highlight change, instead of destroying and recreating all edge
 * graphics (O(n)):
 *   1. Dim the base layer by setting its alpha to 0.15
 *   2. Draw only highlighted edges onto the highlightLayer
 *   3. When the highlight goes away: restore baseLayer alpha, clear highlightLayer
 *
 * This reduces the cost from O(totalEdges) to O(highlightedEdges).
 *
 * The manager is deliberately ignorant of WHERE the highlight comes from: the
 * caller decides (hover, a pinned node, or an induced subgraph -- see
 * `resolveHighlightSource`), fills `highlightedEdgeIndices`, and passes a plain
 * `highlightActive` flag.
 */
export class EdgeDrawingManager {
  edgeData: EdgeDatum[] = [];
  /** Map from node ID to indices in edgeData for quick lookup during hover */
  nodeToEdgeIndices = new Map<string, number[]>();
  highlightedEdgeIndices = new Set<number>();

  /** Base layer: all edges at normal opacity. Only rebuilt on layout/visibility/LOD/drag. */
  private baseLayer: Graphics | null = null;
  /** Highlight layer: only connected edges at full opacity. Only rebuilt on hover. */
  private highlightLayer: Graphics | null = null;
  /** "×N" chips for aggregated base-layer edges. Lives and dies with baseLayer. */
  private baseChipLayer: Container | null = null;
  /** "×N" chips for aggregated highlighted edges. Lives and dies with highlightLayer. */
  private highlightChipLayer: Container | null = null;

  private edgeRedrawFrame: number | null = null;

  /** Stashed state so highlight layer can be rebuilt without full redraw args. */
  private _lastEdgeLayer: Container | null = null;
  private _lastLOD: LODLevel = "detail";
  private _lastVisibleNodes: Set<string> = new Set();
  /** Node refs snapshotted by the last full redraw; reused by highlight-only rebuilds. */
  private _lastNodeRefs: Map<string, NodeDisplayRef> = new Map();
  /** Whether a highlight source (hover or pin) is currently driving the layers. */
  private _highlightActive = false;
  private resolvedPointsByEdgeIndex = new Map<number, Point[]>();

  /**
   * Build edge data from a layout result and populate the node-to-edge index.
   */
  buildEdgeData(layout: LayoutResult): void {
    this.nodeToEdgeIndices.clear();
    this.edgeData = layout.edges.map((e, idx) => {
      if (!this.nodeToEdgeIndices.has(e.source)) {
        this.nodeToEdgeIndices.set(e.source, []);
      }
      this.nodeToEdgeIndices.get(e.source)!.push(idx);

      if (!this.nodeToEdgeIndices.has(e.target)) {
        this.nodeToEdgeIndices.set(e.target, []);
      }
      this.nodeToEdgeIndices.get(e.target)!.push(idx);

      return {
        source: e.source,
        target: e.target,
        color: e.color,
        // Parsed once per layout instead of once per edge per redraw.
        colorInt: parseEdgeColor(e.color),
        kind: e.kind,
        resolution: e.resolution,
        originalPoints: e.points.map((p) => ({ x: p.x, y: p.y })),
        sourceAnchor: e.sourceAnchor,
        targetAnchor: e.targetAnchor,
        count: e.count,
      };
    });
  }

  /**
   * Full redraw of the base layer. Called on layout, visibility, LOD, or drag changes.
   * If a highlight is active, also rebuilds the highlight layer -- which is what
   * makes a pinned selection survive base-layer rebuilds.
   */
  redrawEdgesWithHighlight(
    edgeLayer: Container,
    highlightActive: boolean,
    currentLOD: LODLevel,
    currentVisibleNodes: Set<string>,
    getNodeDisplayRef: (nodeId: string) => NodeDisplayRef | null
  ): void {
    // Stash state for highlight-only redraws
    this._lastEdgeLayer = edgeLayer;
    this._lastLOD = currentLOD;
    this._lastVisibleNodes = currentVisibleNodes;
    this._highlightActive = highlightActive;

    // Destroy old layers
    this.destroyBaseLayer();
    this.destroyHighlightLayer();
    this.resolvedPointsByEdgeIndex.clear();

    if (this.edgeData.length === 0) {
      this._lastNodeRefs = new Map();
      return;
    }

    // ONE scan of the visible nodes for the whole redraw.
    const nodeRefs = snapshotNodeRefs(currentVisibleNodes, getNodeDisplayRef);
    this._lastNodeRefs = nodeRefs;

    const resolvedDraws: ResolvedEdgeDraw[] = [];

    for (const [idx, edge] of this.edgeData.entries()) {
      // Skip edges where either endpoint is not visible
      if (!currentVisibleNodes.has(edge.source) || !currentVisibleNodes.has(edge.target)) {
        continue;
      }

      // Skip edge kinds that should be hidden at current LOD
      if (shouldHideEdgeKindAtLOD(edge.kind, currentLOD)) {
        continue;
      }

      const draw = resolveEdgeDraw(idx, edge, nodeRefs);
      if (!draw) continue;

      resolvedDraws.push(draw);
    }

    spreadEndpointLanes(resolvedDraws, true);
    spreadEndpointLanes(resolvedDraws, false);

    const lodOpacityMultiplier = getLODEdgeOpacity(currentLOD);

    // Budget gate: how much routing this redraw can afford. Above the
    // thresholds the ELK/straight polyline is drawn as-is instead of running an
    // effectively unbounded detour search per edge.
    const routingMode = resolveEdgeRoutingMode({
      renderedEdges: resolvedDraws.length,
      visibleNodes: nodeRefs.size,
      edgesVisible: lodOpacityMultiplier > 0,
    });

    if (routesAroundObstacles(routingMode)) {
      const obstacleIndex = buildObstacleIndex(nodeRefs);
      const scoreCrossings = scoresEdgeCrossings(routingMode);
      const routedPolylines: Point[][] = [];

      for (const draw of resolvedDraws) {
        draw.points = routePolylineAroundObstacles(
          draw.points,
          obstaclesForEdge(obstacleIndex, draw),
          scoreCrossings ? routedPolylines : NO_REFERENCE_POLYLINES
        );
        if (scoreCrossings) {
          routedPolylines.push(draw.points);
        }
      }
    }

    const gfx = new Graphics();
    const chipSpecs: EdgeCountChipSpec[] = [];

    for (const draw of resolvedDraws) {
      const { edge, points } = draw;
      // `points` is freshly built by the resolve/route pass and never mutated
      // in place afterwards, so the highlight layer can share the same array.
      this.resolvedPointsByEdgeIndex.set(draw.index, points);

      const style = edge.kind ? EDGE_STYLES[edge.kind] : DEFAULT_EDGE_STYLE;
      const color = edge.colorInt;
      const ambiguous = edge.resolution === "Ambiguous";
      const alpha =
        style.baseAlpha *
        lodOpacityMultiplier *
        (ambiguous ? AMBIGUOUS_ALPHA_MULTIPLIER : 1);
      // Scale width by edge count (log scale so bundled edges are visually thicker)
      const countScale = edge.count > 1 ? 1 + Math.log2(edge.count) * 0.4 : 1;
      const width = style.width * getLODEdgeWidthMultiplier(currentLOD) * countScale;

      // Skip edges that are too faint
      if (alpha < 0.05) continue;

      renderSingleEdge(gfx, points, color, alpha, width, currentLOD !== "minimap", ambiguous);

      if (shouldShowCountChip(edge.count, currentLOD)) {
        const midpoint = polylineArcMidpoint(points);
        if (midpoint) {
          chipSpecs.push({ position: midpoint, count: edge.count, color, alpha });
        }
      }
    }

    edgeLayer.addChild(gfx);
    this.baseLayer = gfx;

    const chips = buildEdgeCountChipLayer(chipSpecs);
    if (chips) {
      edgeLayer.addChild(chips);
      this.baseChipLayer = chips;
    }

    // If a highlight is active, dim the base layer and draw highlights on top
    if (highlightActive && this.highlightedEdgeIndices.size > 0) {
      this.setBaseLayerAlpha(0.15);
      this.rebuildHighlightLayer();
    }
  }

  /** Keep the base edges and their count chips at the same opacity. */
  private setBaseLayerAlpha(alpha: number): void {
    if (this.baseLayer) {
      this.baseLayer.alpha = alpha;
    }
    if (this.baseChipLayer) {
      this.baseChipLayer.alpha = alpha;
    }
  }

  /**
   * Apply a new highlight (the caller has already refilled
   * `highlightedEdgeIndices`). Only rebuilds the highlight layer if the base
   * layer already exists -- avoids the expensive full base-layer rebuild.
   *
   * Returns true if a highlight-only update was performed (no full redraw
   * needed).
   */
  setHighlightActive(highlightActive: boolean): boolean {
    this._highlightActive = highlightActive;

    if (!this.baseLayer || !this._lastEdgeLayer) {
      // No base layer yet -- caller should trigger a full redraw
      return false;
    }

    // Destroy old highlight layer
    this.destroyHighlightLayer();

    if (highlightActive && this.highlightedEdgeIndices.size > 0) {
      // Dim base layer and draw highlighted edges
      this.setBaseLayerAlpha(0.15);
      this.rebuildHighlightLayer();
    } else {
      // Restore base layer to full opacity
      this.setBaseLayerAlpha(1.0);
    }

    return true;
  }

  /**
   * Rebuild only the highlight layer with the currently highlighted edges.
   * Uses the stashed state from the last full redraw.
   */
  private rebuildHighlightLayer(): void {
    if (!this._lastEdgeLayer || this.highlightedEdgeIndices.size === 0) {
      return;
    }

    const gfx = new Graphics();
    const nodeRefs = this._lastNodeRefs;
    const currentLOD = this._lastLOD;
    const visibleNodes = this._lastVisibleNodes;
    const chipSpecs: EdgeCountChipSpec[] = [];

    for (const idx of this.highlightedEdgeIndices) {
      const edge = this.edgeData[idx];
      if (!edge) continue;

      if (!visibleNodes.has(edge.source) || !visibleNodes.has(edge.target)) {
        continue;
      }

      const points = this.resolvedPointsByEdgeIndex.get(idx) ??
        resolveEdgeDraw(idx, edge, nodeRefs)?.points;
      if (!points) continue;

      const style = edge.kind ? EDGE_STYLES[edge.kind] : DEFAULT_EDGE_STYLE;
      const color = edge.colorInt;
      const ambiguous = edge.resolution === "Ambiguous";
      const alpha = 1.0;
      const width = style.width + 1;

      renderSingleEdge(gfx, points, color, alpha, width, currentLOD !== "minimap", ambiguous);

      if (shouldShowCountChip(edge.count, currentLOD)) {
        const midpoint = polylineArcMidpoint(points);
        if (midpoint) {
          chipSpecs.push({ position: midpoint, count: edge.count, color, alpha });
        }
      }
    }

    this._lastEdgeLayer.addChild(gfx);
    this.highlightLayer = gfx;

    const chips = buildEdgeCountChipLayer(chipSpecs);
    if (chips) {
      this._lastEdgeLayer.addChild(chips);
      this.highlightChipLayer = chips;
    }
  }

  /**
   * Schedule an edge redraw on the next animation frame.
   */
  scheduleEdgeRedraw(callback: () => void): void {
    if (this.edgeRedrawFrame !== null) {
      return;
    }

    this.edgeRedrawFrame = window.requestAnimationFrame(() => {
      this.edgeRedrawFrame = null;
      callback();
    });
  }

  /**
   * Cancel any pending edge redraw and redraw immediately.
   */
  flushEdgeRedraw(callback: () => void): void {
    if (this.edgeRedrawFrame !== null) {
      window.cancelAnimationFrame(this.edgeRedrawFrame);
      this.edgeRedrawFrame = null;
    }
    callback();
  }

  /**
   * Clean up all edge graphics and cancel pending redraws.
   */
  destroyEdgeGraphics(): void {
    if (this.edgeRedrawFrame !== null) {
      window.cancelAnimationFrame(this.edgeRedrawFrame);
      this.edgeRedrawFrame = null;
    }
    this.destroyBaseLayer();
    this.destroyHighlightLayer();
    this.resolvedPointsByEdgeIndex.clear();
    this._lastEdgeLayer = null;
    this._lastNodeRefs = new Map();
  }

  private destroyBaseLayer(): void {
    if (this.baseLayer) {
      this.baseLayer.destroy();
      this.baseLayer = null;
    }
    if (this.baseChipLayer) {
      this.baseChipLayer.destroy({ children: true });
      this.baseChipLayer = null;
    }
  }

  private destroyHighlightLayer(): void {
    if (this.highlightLayer) {
      this.highlightLayer.destroy();
      this.highlightLayer = null;
    }
    if (this.highlightChipLayer) {
      this.highlightChipLayer.destroy({ children: true });
      this.highlightChipLayer = null;
    }
  }

  // --- Test helpers (internal use only) ---

  /** @internal Exposed for testing: whether the base layer exists */
  get _hasBaseLayer(): boolean {
    return this.baseLayer !== null;
  }

  /** @internal Exposed for testing: whether the highlight layer exists */
  get _hasHighlightLayer(): boolean {
    return this.highlightLayer !== null;
  }

  /** @internal Exposed for testing: whether a highlight source is driving the layers */
  get _highlightIsActive(): boolean {
    return this._highlightActive;
  }

  /** @internal Exposed for testing: the base layer alpha value */
  get _baseLayerAlpha(): number | null {
    return this.baseLayer?.alpha ?? null;
  }

  /** @internal Exposed for testing: number of "×N" chips on the base layer */
  get _baseChipCount(): number {
    return this.baseChipLayer?.children.length ?? 0;
  }

  /** @internal Exposed for testing: number of "×N" chips on the highlight layer */
  get _highlightChipCount(): number {
    return this.highlightChipLayer?.children.length ?? 0;
  }
}

/**
 * Get opacity multiplier based on current LOD level and settings
 */
export function getLODEdgeOpacity(currentLOD: LODLevel): number {
  const settings = useViewportStore.getState().edgeLODSettings;
  switch (currentLOD) {
    case "minimap":
      return settings.showEdgesInMinimap ? settings.minimapOpacity : 0;
    case "overview":
      return settings.overviewOpacity;
    case "detail":
    default:
      return 1.0;
  }
}

/**
 * Check if an edge kind should be hidden at current LOD
 */
export function shouldHideEdgeKindAtLOD(kind: EdgeKind | null, currentLOD: LODLevel): boolean {
  if (!kind) return false;
  const settings = useViewportStore.getState().edgeLODSettings;
  if (currentLOD === "overview" && settings.hideAtOverview.has(kind)) {
    return true;
  }
  return false;
}

/**
 * Get width multiplier based on current LOD level
 */
export function getLODEdgeWidthMultiplier(currentLOD: LODLevel): number {
  switch (currentLOD) {
    case "minimap":
      return 0.5;
    case "overview":
      return 0.75;
    case "detail":
    default:
      return 1.0;
  }
}

/** Dash geometry for ambiguous (low-confidence) edges, in layout units. */
const DASH_LENGTH = 6;
const DASH_GAP = 5;
/** Extra alpha reduction applied to ambiguous edges so they read as dimmed. */
export const AMBIGUOUS_ALPHA_MULTIPLIER = 0.45;

/**
 * Draw a polyline as a dashed line into `gfx` (moveTo/lineTo pairs per dash).
 * Pixi has no native dash support; this walks each segment placing alternating
 * on/off runs. Kept cheap (straight segments, no curves) since it runs per redraw.
 */
export function drawDashedPolyline(
  gfx: Graphics,
  points: Point[],
  dashLength: number,
  gapLength: number
): void {
  if (points.length < 2) return;

  let drawing = true; // whether the current run is a dash (vs a gap)
  let remaining = dashLength; // distance left in the current run

  for (let i = 0; i < points.length - 1; i++) {
    let from = points[i];
    const to = points[i + 1];
    let segDx = to.x - from.x;
    let segDy = to.y - from.y;
    let segLen = Math.hypot(segDx, segDy);
    if (segLen < 1e-6) continue;

    let ux = segDx / segLen;
    let uy = segDy / segLen;

    while (segLen > 0) {
      const step = Math.min(remaining, segLen);
      const nx = from.x + ux * step;
      const ny = from.y + uy * step;

      if (drawing) {
        gfx.moveTo(from.x, from.y);
        gfx.lineTo(nx, ny);
      }

      from = { x: nx, y: ny };
      segLen -= step;
      remaining -= step;

      if (remaining <= 1e-6) {
        drawing = !drawing;
        remaining = drawing ? dashLength : gapLength;
      }
    }
  }
}

function drawEdgePath(gfx: Graphics, points: Point[], cornerRadius: number): void {
  if (points.length === 0) return;

  gfx.moveTo(points[0].x, points[0].y);

  if (points.length === 2 || cornerRadius <= 0) {
    for (let i = 1; i < points.length; i++) {
      gfx.lineTo(points[i].x, points[i].y);
    }
    return;
  }

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const current = points[i];
    const next = points[i + 1];
    const inDx = current.x - prev.x;
    const inDy = current.y - prev.y;
    const outDx = next.x - current.x;
    const outDy = next.y - current.y;
    const inLength = Math.hypot(inDx, inDy);
    const outLength = Math.hypot(outDx, outDy);

    if (inLength < 0.001 || outLength < 0.001) {
      gfx.lineTo(current.x, current.y);
      continue;
    }

    const radius = Math.min(cornerRadius, inLength / 2, outLength / 2);
    if (radius < 0.5) {
      gfx.lineTo(current.x, current.y);
      continue;
    }

    const entryX = current.x - (inDx / inLength) * radius;
    const entryY = current.y - (inDy / inLength) * radius;
    const exitX = current.x + (outDx / outLength) * radius;
    const exitY = current.y + (outDy / outLength) * radius;

    gfx.lineTo(entryX, entryY);
    gfx.quadraticCurveTo(current.x, current.y, exitX, exitY);
  }

  const last = points[points.length - 1];
  gfx.lineTo(last.x, last.y);
}

function drawEdgeStartCap(
  gfx: Graphics,
  point: Point,
  color: number,
  alpha: number,
  width: number
): void {
  const radius = Math.max(2, width * 0.95);
  gfx.circle(point.x, point.y, radius);
  gfx.fill({ color, alpha: Math.min(1, alpha * 0.95) });
}

function drawEdgeArrowhead(
  gfx: Graphics,
  from: Point,
  to: Point,
  color: number,
  alpha: number,
  width: number
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);

  if (length < 0.001) {
    return;
  }

  const unitX = dx / length;
  const unitY = dy / length;
  const normalX = -unitY;
  const normalY = unitX;
  const size = Math.max(7, width * 3.2);
  const wing = size * 0.45;
  const baseX = to.x - unitX * size;
  const baseY = to.y - unitY * size;

  gfx.poly([
    to.x,
    to.y,
    baseX + normalX * wing,
    baseY + normalY * wing,
    baseX - normalX * wing,
    baseY - normalY * wing,
  ]);
  gfx.fill({ color, alpha: Math.min(1, alpha * 1.1) });
}
