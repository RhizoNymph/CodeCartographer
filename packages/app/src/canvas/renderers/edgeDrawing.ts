import { Container, Graphics } from "pixi.js";
import type { EdgeKind } from "../../api/types";
import {
  anchorEdgePolyline,
  rerouteOrthogonalEdge,
  translatePolyline,
  type EdgeAnchor,
  type Point,
} from "../layout/edgeGeometry";
import type { LayoutResult } from "../layout/elkLayout";
import { useViewportStore, type LODLevel } from "../../stores/viewportStore";

// Edge styling configuration by type
const EDGE_STYLES: Record<EdgeKind, { width: number; baseAlpha: number }> = {
  Import: { width: 2.5, baseAlpha: 0.9 },
  Inheritance: { width: 2.5, baseAlpha: 0.9 },
  TraitImpl: { width: 2.5, baseAlpha: 0.85 },
  FunctionCall: { width: 2, baseAlpha: 0.8 },
  MethodCall: { width: 2, baseAlpha: 0.8 },
  TypeReference: { width: 2, baseAlpha: 0.75 },
  VariableUsage: { width: 1.5, baseAlpha: 0.5 },
};

const DEFAULT_EDGE_STYLE = { width: 2, baseAlpha: 0.85 };

export interface EdgeDatum {
  source: string;
  target: string;
  color: string;
  kind: EdgeKind | null;
  originalPoints: Point[];
  sourceAnchor: EdgeAnchor;
  targetAnchor: EdgeAnchor;
}

export interface NodeDisplayRef {
  containerX: number;
  containerY: number;
  layoutWidth: number;
  layoutHeight: number;
  layoutX: number;
  layoutY: number;
}

/**
 * Manages all edge-related rendering: building edge data from layout,
 * redrawing with highlight/LOD state, and scheduling redraws during drag.
 */
export class EdgeDrawingManager {
  edgeData: EdgeDatum[] = [];
  /** Map from node ID to indices in edgeData for quick lookup during hover */
  nodeToEdgeIndices = new Map<string, number[]>();
  highlightedEdgeIndices = new Set<number>();

  private edgeGraphics: Graphics | null = null;
  private edgeRedrawFrame: number | null = null;

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
   * Redraw all edges with current hover/LOD/visibility state.
   */
  redrawEdgesWithHighlight(
    edgeLayer: Container,
    hoveredNodeId: string | null,
    currentLOD: LODLevel,
    currentVisibleNodes: Set<string>,
    getNodeDisplayRef: (nodeId: string) => NodeDisplayRef | null
  ): void {
    if (this.edgeData.length === 0) return;

    // Remove old edge graphics
    if (this.edgeGraphics) {
      this.edgeGraphics.destroy();
      this.edgeGraphics = null;
    }

    const gfx = new Graphics();

    // Get connected edge indices for hovered node
    const connectedEdgeIndices = this.highlightedEdgeIndices;

    // Get LOD-based opacity multiplier
    const lodOpacityMultiplier = getLODEdgeOpacity(currentLOD);

    // Draw edges (non-highlighted first, then highlighted on top)
    const edgesToDraw = this.edgeData.map((edge, idx) => ({ edge, idx }));

    // Sort so highlighted edges are drawn last (on top)
    if (hoveredNodeId) {
      edgesToDraw.sort((a, b) => {
        const aConnected = connectedEdgeIndices.has(a.idx);
        const bConnected = connectedEdgeIndices.has(b.idx);
        if (aConnected && !bConnected) return 1;
        if (!aConnected && bConnected) return -1;
        return 0;
      });
    }

    for (const { edge, idx } of edgesToDraw) {
      // Skip edges where either endpoint is not visible
      if (!currentVisibleNodes.has(edge.source) || !currentVisibleNodes.has(edge.target)) {
        continue;
      }

      // Skip edge kinds that should be hidden at current LOD (unless highlighting)
      if (!hoveredNodeId && shouldHideEdgeKindAtLOD(edge.kind, currentLOD)) {
        continue;
      }

      const sourceRef = getNodeDisplayRef(edge.source);
      const targetRef = getNodeDisplayRef(edge.target);

      if (!sourceRef || !targetRef || edge.originalPoints.length < 2) continue;

      const color = parseInt(edge.color.replace("#", ""), 16);
      const style = edge.kind ? EDGE_STYLES[edge.kind] : DEFAULT_EDGE_STYLE;
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

      if (points.length < 2) continue;

      // Calculate alpha based on hover state and LOD
      const isConnected = connectedEdgeIndices.has(idx);
      let alpha: number;
      let width: number;

      if (hoveredNodeId) {
        // Hover mode: highlight connected, dim others
        if (isConnected) {
          alpha = 1.0;
          width = style.width + 1;
        } else {
          alpha = 0.15;
          width = style.width * 0.8;
        }
      } else {
        // Normal mode: apply LOD and base style
        alpha = style.baseAlpha * lodOpacityMultiplier;
        width = style.width * getLODEdgeWidthMultiplier(currentLOD);
      }

      // Skip edges that are too faint
      if (alpha < 0.05) continue;

      drawEdgePath(gfx, points, Math.max(4, width * 2.2));
      gfx.stroke({
        color,
        width,
        alpha,
        cap: "round",
        join: "round",
      });

      if (currentLOD !== "minimap") {
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

    edgeLayer.addChild(gfx);
    this.edgeGraphics = gfx;
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
   * Clean up the edge graphics and cancel pending redraws.
   */
  destroyEdgeGraphics(): void {
    if (this.edgeRedrawFrame !== null) {
      window.cancelAnimationFrame(this.edgeRedrawFrame);
      this.edgeRedrawFrame = null;
    }
    if (this.edgeGraphics) {
      this.edgeGraphics.destroy();
      this.edgeGraphics = null;
    }
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
