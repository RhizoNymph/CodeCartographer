import { Graphics } from "pixi.js";
import type { CodeEdge, EdgeKind } from "../../api/types";
import { EDGE_COLORS } from "../../api/types";

export interface EdgeRenderData {
  edge: CodeEdge;
  points: Array<{ x: number; y: number }>;
}

/**
 * Renders orthogonal edges between nodes.
 */
export class EdgeRenderer {
  private graphics: Graphics;
  private enabledKinds = new Set<EdgeKind>();

  constructor() {
    this.graphics = new Graphics();
  }

  getGraphics(): Graphics {
    return this.graphics;
  }

  setEnabledKinds(kinds: Set<EdgeKind>) {
    this.enabledKinds = kinds;
  }

  render(edges: EdgeRenderData[]) {
    this.graphics.clear();

    for (const { edge, points } of edges) {
      if (!this.enabledKinds.has(edge.kind)) continue;
      if (points.length < 2) continue;

      const color = parseInt(
        EDGE_COLORS[edge.kind].replace("#", ""),
        16
      );

      // Draw the edge path
      this.graphics.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        this.graphics.lineTo(points[i].x, points[i].y);
      }
      this.graphics.stroke({ color, width: 1.5, alpha: 0.6 });

      // Draw arrowhead at the end
      const last = points[points.length - 1];
      const prev = points[points.length - 2];
      this.drawArrowhead(prev, last, color);
    }
  }

  private drawArrowhead(
    from: { x: number; y: number },
    to: { x: number; y: number },
    color: number
  ) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const size = 8;

    const x1 = to.x - size * Math.cos(angle - Math.PI / 6);
    const y1 = to.y - size * Math.sin(angle - Math.PI / 6);
    const x2 = to.x - size * Math.cos(angle + Math.PI / 6);
    const y2 = to.y - size * Math.sin(angle + Math.PI / 6);

    this.graphics.moveTo(to.x, to.y);
    this.graphics.lineTo(x1, y1);
    this.graphics.moveTo(to.x, to.y);
    this.graphics.lineTo(x2, y2);
    this.graphics.stroke({ color, width: 2, alpha: 0.8 });
  }

  destroy() {
    this.graphics.destroy();
  }
}
