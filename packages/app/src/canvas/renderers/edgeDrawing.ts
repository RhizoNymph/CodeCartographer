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
import type { LayoutResult } from "../layout/elkLayout";
import { useViewportStore, type LODLevel } from "../../stores/viewportStore";
import {
  EDGE_STYLES,
  DEFAULT_EDGE_STYLE,
  type EdgeDatum,
  type NodeDisplayRef,
} from "./types";

// Re-export types for backwards compatibility with existing imports
export type { EdgeDatum, NodeDisplayRef } from "./types";

interface ResolvedEdgeDraw {
  index: number;
  edge: EdgeDatum;
  points: Point[];
  sourceBox: NodeBox;
  targetBox: NodeBox;
  obstacles: NodeBox[];
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
 * Resolves edge routing points for a single edge given current node positions.
 * Extracted so both base and highlight layers can share this logic.
 */
function resolveEdgeDraw(
  index: number,
  edge: EdgeDatum,
  visibleNodes: Set<string>,
  getNodeDisplayRef: (nodeId: string) => NodeDisplayRef | null
): ResolvedEdgeDraw | null {
  const sourceRef = getNodeDisplayRef(edge.source);
  const targetRef = getNodeDisplayRef(edge.target);

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
  const sourceCenter = getBoxCenter(sourceBox);
  const targetCenter = getBoxCenter(targetBox);
  const obstacles: NodeBox[] = [];

  for (const nodeId of visibleNodes) {
    if (nodeId === edge.source || nodeId === edge.target) {
      continue;
    }

    const ref = getNodeDisplayRef(nodeId);
    if (!ref) {
      continue;
    }

    const labelObstacle = nodeRefToLabelObstacle(ref);
    if (
      labelObstacle &&
      !boxContainsPoint(labelObstacle, sourceCenter) &&
      !boxContainsPoint(labelObstacle, targetCenter)
    ) {
      obstacles.push(labelObstacle);
    }

    const box = nodeRefToBox(ref);
    if (!boxContainsPoint(box, sourceCenter) && !boxContainsPoint(box, targetCenter)) {
      obstacles.push(box);
    }
  }

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
    ? { index, edge, points, sourceBox, targetBox, obstacles }
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
 * - **highlightLayer**: contains ONLY the highlighted (connected-to-hovered-node)
 *   edges at full opacity. Rebuilt on hover change only.
 *
 * On hover, instead of destroying and recreating all edge graphics (O(n)):
 *   1. Dim the base layer by setting its alpha to 0.15
 *   2. Draw only highlighted edges onto the highlightLayer
 *   3. On unhover: restore baseLayer alpha, clear highlightLayer
 *
 * This reduces hover cost from O(totalEdges) to O(connectedEdges).
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

  private edgeRedrawFrame: number | null = null;

  /** Stashed state so highlight layer can be rebuilt without full redraw args. */
  private _lastEdgeLayer: Container | null = null;
  private _lastLOD: LODLevel = "detail";
  private _lastVisibleNodes: Set<string> = new Set();
  private _lastGetRef: ((nodeId: string) => NodeDisplayRef | null) | null = null;
  private _hoveredNodeId: string | null = null;
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
   * If a node is currently hovered, also rebuilds the highlight layer.
   */
  redrawEdgesWithHighlight(
    edgeLayer: Container,
    hoveredNodeId: string | null,
    currentLOD: LODLevel,
    currentVisibleNodes: Set<string>,
    getNodeDisplayRef: (nodeId: string) => NodeDisplayRef | null
  ): void {
    // Stash state for highlight-only redraws
    this._lastEdgeLayer = edgeLayer;
    this._lastLOD = currentLOD;
    this._lastVisibleNodes = currentVisibleNodes;
    this._lastGetRef = getNodeDisplayRef;
    this._hoveredNodeId = hoveredNodeId;

    // Destroy old layers
    this.destroyBaseLayer();
    this.destroyHighlightLayer();
    this.resolvedPointsByEdgeIndex.clear();

    if (this.edgeData.length === 0) return;

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

      const draw = resolveEdgeDraw(idx, edge, currentVisibleNodes, getNodeDisplayRef);
      if (!draw) continue;

      resolvedDraws.push(draw);
    }

    spreadEndpointLanes(resolvedDraws, true);
    spreadEndpointLanes(resolvedDraws, false);
    const routedPolylines: Point[][] = [];
    for (const draw of resolvedDraws) {
      draw.points = routePolylineAroundObstacles(
        draw.points,
        draw.obstacles,
        routedPolylines
      );
      routedPolylines.push(draw.points);
    }

    const gfx = new Graphics();
    const lodOpacityMultiplier = getLODEdgeOpacity(currentLOD);

    for (const draw of resolvedDraws) {
      const { edge, points } = draw;
      this.resolvedPointsByEdgeIndex.set(
        draw.index,
        points.map((point) => ({ ...point }))
      );

      const style = edge.kind ? EDGE_STYLES[edge.kind] : DEFAULT_EDGE_STYLE;
      const color = parseInt(edge.color.replace("#", ""), 16);
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
    }

    edgeLayer.addChild(gfx);
    this.baseLayer = gfx;

    // If hovered, dim the base layer and draw highlights on top
    if (hoveredNodeId && this.highlightedEdgeIndices.size > 0) {
      this.baseLayer.alpha = 0.15;
      this.rebuildHighlightLayer();
    }
  }

  /**
   * Update hover state. Only rebuilds the highlight layer if the base layer
   * already exists -- avoids the expensive full base-layer rebuild.
   *
   * Returns true if a hover-only update was performed (no full redraw needed).
   */
  setHoveredNode(hoveredNodeId: string | null): boolean {
    this._hoveredNodeId = hoveredNodeId;

    if (!this.baseLayer || !this._lastEdgeLayer) {
      // No base layer yet -- caller should trigger a full redraw
      return false;
    }

    // Destroy old highlight layer
    this.destroyHighlightLayer();

    if (hoveredNodeId && this.highlightedEdgeIndices.size > 0) {
      // Dim base layer and draw highlighted edges
      this.baseLayer.alpha = 0.15;
      this.rebuildHighlightLayer();
    } else {
      // Restore base layer to full opacity
      this.baseLayer.alpha = 1.0;
    }

    return true;
  }

  /**
   * Rebuild only the highlight layer with the currently highlighted edges.
   * Uses the stashed state from the last full redraw.
   */
  private rebuildHighlightLayer(): void {
    if (
      !this._lastEdgeLayer ||
      !this._lastGetRef ||
      this.highlightedEdgeIndices.size === 0
    ) {
      return;
    }

    const gfx = new Graphics();
    const getRef = this._lastGetRef;
    const currentLOD = this._lastLOD;
    const visibleNodes = this._lastVisibleNodes;

    for (const idx of this.highlightedEdgeIndices) {
      const edge = this.edgeData[idx];
      if (!edge) continue;

      if (!visibleNodes.has(edge.source) || !visibleNodes.has(edge.target)) {
        continue;
      }

      const points = this.resolvedPointsByEdgeIndex.get(idx) ??
        resolveEdgeDraw(idx, edge, visibleNodes, getRef)?.points;
      if (!points) continue;

      const style = edge.kind ? EDGE_STYLES[edge.kind] : DEFAULT_EDGE_STYLE;
      const color = parseInt(edge.color.replace("#", ""), 16);
      const ambiguous = edge.resolution === "Ambiguous";
      const alpha = 1.0;
      const width = style.width + 1;

      renderSingleEdge(gfx, points, color, alpha, width, currentLOD !== "minimap", ambiguous);
    }

    this._lastEdgeLayer.addChild(gfx);
    this.highlightLayer = gfx;
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
    this._lastEdgeLayer = null;
    this._lastGetRef = null;
  }

  private destroyBaseLayer(): void {
    if (this.baseLayer) {
      this.baseLayer.destroy();
      this.baseLayer = null;
    }
  }

  private destroyHighlightLayer(): void {
    if (this.highlightLayer) {
      this.highlightLayer.destroy();
      this.highlightLayer = null;
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

  /** @internal Exposed for testing: the base layer alpha value */
  get _baseLayerAlpha(): number | null {
    return this.baseLayer?.alpha ?? null;
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
