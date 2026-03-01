import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { Viewport } from "pixi-viewport";
import type { CodeGraph, CodeNode } from "../../api/types";
import { BLOCK_COLORS } from "../../api/types";
import { layoutGraph, type LayoutResult, type LayoutNodePosition } from "../layout/elkLayout";
import { useGraphStore } from "../../stores/graphStore";
import { useViewportStore, type LODLevel } from "../../stores/viewportStore";
import { CullingManager } from "../culling/cullingManager";

interface NodeDisplay {
  container: Container;
  bg: Graphics;
  label: Text;
  nodeData: CodeNode;
  layoutPos: LayoutNodePosition;
}

export class PixiRenderer {
  private app: Application;
  private viewport!: Viewport;
  private nodeDisplays = new Map<string, NodeDisplay>();
  private edgeGraphics: Graphics | null = null;
  private minimapGraphics: Graphics | null = null;
  private resizeObserver: ResizeObserver;
  private containerEl: HTMLElement;
  private initialized = false;
  private selectedNodeId: string | null = null;
  private currentLOD: LODLevel = "detail";
  private cullingManager = new CullingManager();
  private lastLayout: LayoutResult | null = null;
  private currentGraph: CodeGraph | null = null;

  // Drag state
  private dragTarget: { nodeId: string; offsetX: number; offsetY: number } | null = null;

  private pendingUpdate: {
    graph: CodeGraph;
    expanded: Set<string>;
    visible: Set<string>;
  } | null = null;

  private initPromise: Promise<void>;
  private destroyed = false;

  constructor(container: HTMLElement) {
    this.containerEl = container;
    this.app = new Application();

    this.initPromise = this.initAsync(container);

    this.resizeObserver = new ResizeObserver(() => {
      if (this.initialized && !this.destroyed) {
        this.app.renderer.resize(container.clientWidth, container.clientHeight);
        this.viewport.resize(container.clientWidth, container.clientHeight);
      }
    });
    this.resizeObserver.observe(container);
  }

  waitForInit(): Promise<void> {
    return this.initPromise;
  }

  private async initAsync(container: HTMLElement) {
    try {
      await this.app.init({
        width: container.clientWidth || 800,
        height: container.clientHeight || 600,
        backgroundColor: 0x0f172a,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        preferWebGLVersion: 2,
      });
    } catch (e1) {
      console.warn("WebGL2 init failed, trying WebGL1:", e1);
      try {
        await this.app.init({
          width: container.clientWidth || 800,
          height: container.clientHeight || 600,
          backgroundColor: 0x0f172a,
          antialias: false,
          resolution: 1,
          autoDensity: true,
        });
      } catch (e2) {
        throw new Error(`Pixi.js failed to initialize: ${e2}`);
      }
    }

    if (this.destroyed) return;

    container.appendChild(this.app.canvas as HTMLCanvasElement);

    this.viewport = new Viewport({
      screenWidth: container.clientWidth || 800,
      screenHeight: container.clientHeight || 600,
      worldWidth: 20000,
      worldHeight: 20000,
      events: this.app.renderer.events,
    });

    this.viewport
      .drag()
      .pinch()
      .wheel({ smooth: 5 })
      .decelerate({ friction: 0.95 })
      .clampZoom({ minScale: 0.02, maxScale: 4 });

    this.app.stage.addChild(this.viewport);

    // Track viewport changes for LOD and culling
    this.viewport.on("moved", () => {
      this.onViewportChanged();
    });

    // Click on empty space to deselect
    this.viewport.on("pointerdown", () => {
      if (!this.dragTarget) {
        useGraphStore.getState().setSelectedNode(null);
      }
    });

    this.initialized = true;

    // Process any pending update
    if (this.pendingUpdate) {
      const { graph, expanded, visible } = this.pendingUpdate;
      this.pendingUpdate = null;
      this.updateGraph(graph, expanded, visible);
    }
  }

  private onViewportChanged() {
    const bounds = this.viewport.getVisibleBounds();
    const scale = this.viewport.scale.x;

    useViewportStore.getState().updateViewport(
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      scale
    );

    // Update LOD
    const newLOD = useViewportStore.getState().lodLevel;
    if (newLOD !== this.currentLOD) {
      this.currentLOD = newLOD;
      this.updateLODVisibility();
    }

    // Update minimap
    this.updateMinimap();
  }

  private updateLODVisibility() {
    for (const [nodeId, display] of this.nodeDisplays) {
      const node = display.nodeData;

      if (node.type === "CodeBlock") {
        // Hide code blocks at overview/minimap zoom
        display.container.visible = this.currentLOD === "detail";
      } else if (node.type === "File") {
        // Show files at overview and detail
        display.container.visible = this.currentLOD !== "minimap";
        display.label.visible = this.currentLOD === "detail";
      } else {
        // Directories always visible
        display.label.visible = this.currentLOD !== "minimap";
      }
    }
  }

  updateGraph(
    graph: CodeGraph,
    expandedNodes: Set<string>,
    visibleNodes: Set<string>
  ) {
    if (!this.initialized) {
      this.pendingUpdate = { graph, expanded: expandedNodes, visible: visibleNodes };
      return;
    }

    this.currentGraph = graph;

    // Run layout
    layoutGraph(graph, expandedNodes, visibleNodes).then((layout) => {
      this.lastLayout = layout;
      this.renderFromLayout(graph, layout, expandedNodes, visibleNodes);
    });
  }

  private renderFromLayout(
    graph: CodeGraph,
    layout: LayoutResult,
    expandedNodes: Set<string>,
    _visibleNodes: Set<string>
  ) {
    // Clear existing displays
    for (const [, display] of this.nodeDisplays) {
      display.container.destroy({ children: true });
    }
    this.nodeDisplays.clear();
    this.cullingManager.clear();

    if (this.edgeGraphics) {
      this.edgeGraphics.destroy();
      this.edgeGraphics = null;
    }

    // Create node displays from layout
    for (const [nodeId, pos] of Object.entries(layout.nodes)) {
      const node = graph.nodes[nodeId];
      if (!node) continue;

      this.createNodeDisplay(nodeId, node, pos, expandedNodes.has(nodeId));
      this.cullingManager.upsert(nodeId, pos.x, pos.y, pos.width, pos.height);
    }

    // Draw edges
    this.drawEdges(layout);

    // Initial LOD update
    this.updateLODVisibility();

    // Fit viewport to content
    if (this.nodeDisplays.size > 0) {
      // Calculate content bounds
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pos of Object.values(layout.nodes)) {
        minX = Math.min(minX, pos.x);
        minY = Math.min(minY, pos.y);
        maxX = Math.max(maxX, pos.x + pos.width);
        maxY = Math.max(maxY, pos.y + pos.height);
      }

      const padding = 50;
      this.viewport.moveCenter(
        (minX + maxX) / 2,
        (minY + maxY) / 2
      );

      const contentW = maxX - minX + padding * 2;
      const contentH = maxY - minY + padding * 2;
      const scaleX = this.viewport.screenWidth / contentW;
      const scaleY = this.viewport.screenHeight / contentH;
      const fitScale = Math.min(scaleX, scaleY, 1);
      this.viewport.setZoom(fitScale, true);
    }
  }

  private createNodeDisplay(
    nodeId: string,
    node: CodeNode,
    pos: LayoutNodePosition,
    _isExpanded: boolean
  ) {
    const container = new Container();
    container.x = pos.x;
    container.y = pos.y;
    container.eventMode = "static";
    container.cursor = "pointer";

    // Background
    const bg = new Graphics();
    const color = this.getNodeColor(node);
    const borderColor = this.selectedNodeId === nodeId ? 0x60a5fa : 0x334155;
    const borderWidth = this.selectedNodeId === nodeId ? 3 : 1;

    bg.roundRect(0, 0, pos.width, pos.height, 8);
    bg.fill({ color });
    bg.stroke({ color: borderColor, width: borderWidth });

    container.addChild(bg);

    // Label
    const fontSize = node.type === "CodeBlock" ? 11 : 13;
    const label = new Text({
      text: this.getNodeLabel(node),
      style: new TextStyle({
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize,
        fill: node.type === "CodeBlock" ? "#cbd5e1" : "#f1f5f9",
        wordWrap: true,
        wordWrapWidth: Math.max(pos.width - 16, 40),
      }),
    });
    label.x = 8;
    label.y = 6;
    container.addChild(label);

    // Click handler
    container.on("pointerdown", (e) => {
      e.stopPropagation();
      useGraphStore.getState().setSelectedNode(nodeId);

      // Start drag
      const local = this.viewport.toLocal(e.global);
      this.dragTarget = {
        nodeId,
        offsetX: local.x - container.x,
        offsetY: local.y - container.y,
      };
    });

    // Drag
    container.on("globalpointermove", (e) => {
      if (this.dragTarget && this.dragTarget.nodeId === nodeId) {
        const local = this.viewport.toLocal(e.global);
        container.x = local.x - this.dragTarget.offsetX;
        container.y = local.y - this.dragTarget.offsetY;
      }
    });

    container.on("pointerup", () => {
      this.dragTarget = null;
    });

    container.on("pointerupoutside", () => {
      this.dragTarget = null;
    });

    // Double-click to expand/collapse
    let lastClickTime = 0;
    container.on("pointertap", () => {
      const now = Date.now();
      if (now - lastClickTime < 350) {
        useGraphStore.getState().toggleExpanded(nodeId);
      }
      lastClickTime = now;
    });

    // Hover
    container.on("pointerover", () => {
      useGraphStore.getState().setHoveredNode(nodeId);
      bg.tint = 0xdddddd;
    });
    container.on("pointerout", () => {
      useGraphStore.getState().setHoveredNode(null);
      bg.tint = 0xffffff;
    });

    this.viewport.addChild(container);

    this.nodeDisplays.set(nodeId, {
      container,
      bg,
      label,
      nodeData: node,
      layoutPos: pos,
    });
  }

  private getNodeColor(node: CodeNode): number {
    switch (node.type) {
      case "Directory":
        return 0x1e293b;
      case "File":
        return 0x1e3a5f;
      case "CodeBlock": {
        const hex = BLOCK_COLORS[node.kind] || "#334155";
        const base = parseInt(hex.replace("#", ""), 16);
        // Darken for background
        const r = Math.floor(((base >> 16) & 0xff) * 0.25);
        const g = Math.floor(((base >> 8) & 0xff) * 0.25);
        const b = Math.floor((base & 0xff) * 0.25);
        return (r << 16) | (g << 8) | b;
      }
    }
  }

  private getNodeLabel(node: CodeNode): string {
    switch (node.type) {
      case "Directory":
        return node.name;
      case "File":
        return node.name;
      case "CodeBlock":
        return `${this.blockKindPrefix(node.kind)} ${node.name}`;
    }
  }

  private blockKindPrefix(kind: string): string {
    switch (kind) {
      case "Function": return "fn";
      case "Class": return "class";
      case "Struct": return "struct";
      case "Enum": return "enum";
      case "Trait": return "trait";
      case "Interface": return "iface";
      case "Impl": return "impl";
      case "Module": return "mod";
      case "Constant": return "const";
      case "TypeAlias": return "type";
      default: return "";
    }
  }

  private drawEdges(layout: LayoutResult) {
    if (layout.edges.length === 0) return;

    const gfx = new Graphics();

    for (const edge of layout.edges) {
      const color = parseInt(edge.color.replace("#", ""), 16);

      if (edge.points.length >= 2) {
        gfx.moveTo(edge.points[0].x, edge.points[0].y);
        for (let i = 1; i < edge.points.length; i++) {
          gfx.lineTo(edge.points[i].x, edge.points[i].y);
        }
        gfx.stroke({ color, width: 1.5, alpha: 0.6 });

        // Arrowhead
        const last = edge.points[edge.points.length - 1];
        const prev = edge.points[edge.points.length - 2];
        const angle = Math.atan2(last.y - prev.y, last.x - prev.x);
        const size = 7;

        gfx.moveTo(last.x, last.y);
        gfx.lineTo(
          last.x - size * Math.cos(angle - Math.PI / 6),
          last.y - size * Math.sin(angle - Math.PI / 6)
        );
        gfx.moveTo(last.x, last.y);
        gfx.lineTo(
          last.x - size * Math.cos(angle + Math.PI / 6),
          last.y - size * Math.sin(angle + Math.PI / 6)
        );
        gfx.stroke({ color, width: 2, alpha: 0.8 });
      }
    }

    this.viewport.addChild(gfx);
    this.edgeGraphics = gfx;
  }

  private updateMinimap() {
    // Simple minimap in bottom-right corner
    if (this.minimapGraphics) {
      this.minimapGraphics.destroy();
    }

    if (!this.lastLayout || this.nodeDisplays.size === 0) return;

    const gfx = new Graphics();
    const mmWidth = 150;
    const mmHeight = 100;
    const mmX = this.containerEl.clientWidth - mmWidth - 10;
    const mmY = this.containerEl.clientHeight - mmHeight - 10;

    // Background
    gfx.roundRect(mmX, mmY, mmWidth, mmHeight, 4);
    gfx.fill({ color: 0x1e293b, alpha: 0.85 });
    gfx.stroke({ color: 0x334155, width: 1 });

    // Calculate world bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pos of Object.values(this.lastLayout.nodes)) {
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

    // Draw nodes as small dots
    for (const pos of Object.values(this.lastLayout.nodes)) {
      const rx = mmX + 4 + (pos.x - minX) * mmScale;
      const ry = mmY + 4 + (pos.y - minY) * mmScale;
      const rw = Math.max(pos.width * mmScale, 2);
      const rh = Math.max(pos.height * mmScale, 1);

      gfx.rect(rx, ry, rw, rh);
      gfx.fill({ color: 0x3b82f6, alpha: 0.5 });
    }

    // Draw viewport rectangle
    const vp = this.viewport.getVisibleBounds();
    const vpRx = mmX + 4 + (vp.x - minX) * mmScale;
    const vpRy = mmY + 4 + (vp.y - minY) * mmScale;
    const vpRw = vp.width * mmScale;
    const vpRh = vp.height * mmScale;

    gfx.rect(vpRx, vpRy, vpRw, vpRh);
    gfx.stroke({ color: 0x60a5fa, width: 1.5 });

    this.app.stage.addChild(gfx);
    this.minimapGraphics = gfx;
  }

  setSelectedNode(nodeId: string | null) {
    const prev = this.selectedNodeId;
    this.selectedNodeId = nodeId;

    // Update visual for previous
    if (prev) {
      const display = this.nodeDisplays.get(prev);
      if (display) {
        this.redrawNodeBg(display, false);
      }
    }

    // Update visual for new
    if (nodeId) {
      const display = this.nodeDisplays.get(nodeId);
      if (display) {
        this.redrawNodeBg(display, true);
      }
    }
  }

  /**
   * Animate the viewport to center on a specific node.
   */
  zoomToNode(nodeId: string) {
    const display = this.nodeDisplays.get(nodeId);
    if (!display) return;

    const pos = display.layoutPos;
    const centerX = pos.x + pos.width / 2;
    const centerY = pos.y + pos.height / 2;

    this.viewport.animate({
      position: { x: centerX, y: centerY },
      scale: 1.5,
      time: 500,
      ease: "easeInOutQuad",
    });

    useGraphStore.getState().setSelectedNode(nodeId);
  }

  private redrawNodeBg(display: NodeDisplay, selected: boolean) {
    const bg = display.bg;
    const pos = display.layoutPos;
    const color = this.getNodeColor(display.nodeData);

    bg.clear();
    bg.roundRect(0, 0, pos.width, pos.height, 8);
    bg.fill({ color });
    bg.stroke({
      color: selected ? 0x60a5fa : 0x334155,
      width: selected ? 3 : 1,
    });
  }

  destroy() {
    this.destroyed = true;
    this.resizeObserver.disconnect();
    if (!this.initialized) return;
    if (this.minimapGraphics) {
      this.minimapGraphics.destroy();
    }
    try {
      this.app.destroy(true, { children: true });
    } catch {
      // Pixi may already be partially torn down
    }
  }
}
