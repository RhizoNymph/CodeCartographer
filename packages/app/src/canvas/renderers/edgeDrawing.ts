import { Container, Graphics } from "pixi.js";
import type { EdgeKind } from "../../api/types";
import {
  anchorEdgePolyline,
  rerouteOrthogonalEdge,
  translatePolyline,
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

/**
 * Resolves edge routing points for a single edge given current node positions.
 * Extracted so both base and highlight layers can share this logic.
 */
function resolveEdgePoints(
  edge: EdgeDatum,
  getNodeDisplayRef: (nodeId: string) => NodeDisplayRef | null
): Point[] | null {
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

  let points: Point[];
  if (!sourceMoved && !targetMoved) {
    points = anchorEdgePolyline(
      edge.originalPoints,
      sourceBox,
      targetBox,
      edge.sourceAnchor,
      edge.targetAnchor
    );
  } else if (
    Math.abs(sourceDx - targetDx) <= 1 &&
    Math.abs(sourceDy - targetDy) <= 1
  ) {
    points = anchorEdgePolyline(
      translatePolyline(
        edge.originalPoints,
        (sourceDx + targetDx) / 2,
        (sourceDy + targetDy) / 2
      ),
      sourceBox,
      targetBox,
      edge.sourceAnchor,
      edge.targetAnchor
    );
  } else {
    points = rerouteOrthogonalEdge(
      edge.originalPoints,
      sourceBox,
      targetBox,
      edge.sourceAnchor,
      edge.targetAnchor
    );
  }

  return points.length >= 2 ? points : null;
}

/**
 * Draw a single edge (path + start cap + arrowhead) into a Graphics object.
 */
function renderSingleEdge(
  gfx: Graphics,
  points: Point[],
  color: number,
  alpha: number,
  width: number,
  showStartCap: boolean
): void {
  drawEdgePath(gfx, points, Math.max(4, width * 2.2));
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
        originalPoints: e.points.map((p) => ({ x: p.x, y: p.y })),
        sourceAnchor: e.sourceAnchor,
        targetAnchor: e.targetAnchor,
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

    if (this.edgeData.length === 0) return;

    // Destroy old layers
    this.destroyBaseLayer();
    this.destroyHighlightLayer();

    const gfx = new Graphics();
    const lodOpacityMultiplier = getLODEdgeOpacity(currentLOD);

    for (const [idx, edge] of this.edgeData.entries()) {
      // Skip edges where either endpoint is not visible
      if (!currentVisibleNodes.has(edge.source) || !currentVisibleNodes.has(edge.target)) {
        continue;
      }

      // Skip edge kinds that should be hidden at current LOD
      if (shouldHideEdgeKindAtLOD(edge.kind, currentLOD)) {
        continue;
      }

      const points = resolveEdgePoints(edge, getNodeDisplayRef);
      if (!points) continue;

      const style = edge.kind ? EDGE_STYLES[edge.kind] : DEFAULT_EDGE_STYLE;
      const color = parseInt(edge.color.replace("#", ""), 16);
      const alpha = style.baseAlpha * lodOpacityMultiplier;
      const width = style.width * getLODEdgeWidthMultiplier(currentLOD);

      // Skip edges that are too faint
      if (alpha < 0.05) continue;

      renderSingleEdge(gfx, points, color, alpha, width, currentLOD !== "minimap");
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

      const points = resolveEdgePoints(edge, getRef);
      if (!points) continue;

      const style = edge.kind ? EDGE_STYLES[edge.kind] : DEFAULT_EDGE_STYLE;
      const color = parseInt(edge.color.replace("#", ""), 16);
      const alpha = 1.0;
      const width = style.width + 1;

      renderSingleEdge(gfx, points, color, alpha, width, currentLOD !== "minimap");
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
