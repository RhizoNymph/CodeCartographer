import { Application, Graphics } from "pixi.js";
import type { Viewport } from "pixi-viewport";
import type { LayoutResult } from "../layout/elkLayout";

interface MinimapGeometry {
  mmX: number;
  mmY: number;
  mmWidth: number;
  mmHeight: number;
  minX: number;
  minY: number;
  mmScale: number;
}

/**
 * Manages the minimap overlay: a small rectangle in the corner showing
 * an overview of all nodes and the current viewport position.
 */
export class MinimapRenderer {
  private _minimapNodesGfx: Graphics | null = null;
  private _minimapViewportGfx: Graphics | null = null;
  private _minimapLayoutVersion: LayoutResult | null = null;

  /**
   * Compute minimap geometry (world bounds and scale) from a layout.
   * Returns null if no layout / no nodes.
   */
  private getMinimapGeometry(
    lastLayout: LayoutResult | null,
    nodeCount: number,
    containerWidth: number,
    containerHeight: number
  ): MinimapGeometry | null {
    if (!lastLayout || nodeCount === 0) return null;

    const mmWidth = 150;
    const mmHeight = 100;
    const mmX = containerWidth - mmWidth - 10;
    const mmY = containerHeight - mmHeight - 10;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pos of Object.values(lastLayout.nodes)) {
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + pos.width);
      maxY = Math.max(maxY, pos.y + pos.height);
    }

    const worldW = maxX - minX || 1;
    const worldH = maxY - minY || 1;
    const scaleX = (mmWidth - 8) / worldW;
    const scaleY = (mmHeight - 8) / worldH;
    const mmScale = Math.min(scaleX, scaleY);

    return { mmX, mmY, mmWidth, mmHeight, minX, minY, mmScale };
  }

  /**
   * Rebuild the static minimap nodes layer (background + node rectangles).
   * Only called when the layout reference changes.
   */
  private rebuildMinimapNodes(
    app: Application,
    lastLayout: LayoutResult | null,
    nodeCount: number,
    containerWidth: number,
    containerHeight: number
  ): void {
    if (this._minimapLayoutVersion === lastLayout) return;
    this._minimapLayoutVersion = lastLayout;

    if (this._minimapNodesGfx) {
      this._minimapNodesGfx.destroy();
      this._minimapNodesGfx = null;
    }

    const geo = this.getMinimapGeometry(lastLayout, nodeCount, containerWidth, containerHeight);
    if (!geo) return;

    const gfx = new Graphics();

    // Background
    gfx.roundRect(geo.mmX, geo.mmY, geo.mmWidth, geo.mmHeight, 4);
    gfx.fill({ color: 0x1e293b, alpha: 0.85 });
    gfx.stroke({ color: 0x334155, width: 1 });

    // Draw nodes as small rectangles
    for (const pos of Object.values(lastLayout!.nodes)) {
      const rx = geo.mmX + 4 + (pos.x - geo.minX) * geo.mmScale;
      const ry = geo.mmY + 4 + (pos.y - geo.minY) * geo.mmScale;
      const rw = Math.max(pos.width * geo.mmScale, 2);
      const rh = Math.max(pos.height * geo.mmScale, 1);

      gfx.rect(rx, ry, rw, rh);
      gfx.fill({ color: 0x3b82f6, alpha: 0.5 });
    }

    app.stage.addChild(gfx);
    this._minimapNodesGfx = gfx;
  }

  /**
   * Update the minimap: rebuild static nodes if layout changed, then
   * redraw the viewport rectangle overlay.
   */
  updateMinimap(
    app: Application,
    viewport: Viewport,
    lastLayout: LayoutResult | null,
    nodeCount: number,
    containerWidth: number,
    containerHeight: number
  ): void {
    // Rebuild static node layer only when layout changes
    this.rebuildMinimapNodes(app, lastLayout, nodeCount, containerWidth, containerHeight);

    // Destroy/recreate only the viewport rectangle overlay
    if (this._minimapViewportGfx) {
      this._minimapViewportGfx.destroy();
      this._minimapViewportGfx = null;
    }

    const geo = this.getMinimapGeometry(lastLayout, nodeCount, containerWidth, containerHeight);
    if (!geo) return;

    const vpGfx = new Graphics();
    const vp = viewport.getVisibleBounds();
    const vpRx = geo.mmX + 4 + (vp.x - geo.minX) * geo.mmScale;
    const vpRy = geo.mmY + 4 + (vp.y - geo.minY) * geo.mmScale;
    const vpRw = vp.width * geo.mmScale;
    const vpRh = vp.height * geo.mmScale;

    vpGfx.rect(vpRx, vpRy, vpRw, vpRh);
    vpGfx.stroke({ color: 0x60a5fa, width: 1.5 });

    app.stage.addChild(vpGfx);
    this._minimapViewportGfx = vpGfx;
  }

  /**
   * Clean up all minimap graphics.
   */
  destroy(): void {
    if (this._minimapNodesGfx) {
      this._minimapNodesGfx.destroy();
      this._minimapNodesGfx = null;
    }
    if (this._minimapViewportGfx) {
      this._minimapViewportGfx.destroy();
      this._minimapViewportGfx = null;
    }
  }
}
