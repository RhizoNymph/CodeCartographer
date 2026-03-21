import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { Viewport } from "pixi-viewport";
import type { CodeGraph, CodeNode, EdgeKind } from "../../api/types";
import { BLOCK_COLORS } from "../../api/types";
import { layoutGraph, type LayoutResult, type LayoutNodePosition } from "../layout/elkLayout";
import {
  anchorEdgePolyline,
  rerouteOrthogonalEdge,
  translatePolyline,
  type EdgeAnchor,
  type Point,
} from "../layout/edgeGeometry";
import { useGraphStore } from "../../stores/graphStore";
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

interface NodeDisplay {
  container: Container;
  bg: Graphics;
  label: Text;
  nodeData: CodeNode;
  layoutPos: LayoutNodePosition;
}

interface NodePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export class PixiRenderer {
  private app: Application;
  private viewport!: Viewport;
  private containerLayer!: Container;
  private edgeLayer!: Container;
  private componentLayer!: Container;
  private nodeDisplays = new Map<string, NodeDisplay>();
  private edgeGraphics: Graphics | null = null;
  private edgeData: Array<{
    source: string;
    target: string;
    color: string;
    kind: EdgeKind | null;
    originalPoints: Point[];
    sourceAnchor: EdgeAnchor;
    targetAnchor: EdgeAnchor;
  }> = [];
  // Map from node ID to indices in edgeData for quick lookup during hover
  private nodeToEdgeIndices = new Map<string, number[]>();
  private highlightedEdgeIndices = new Set<number>();
  private hoveredNodeId: string | null = null;
  private currentEnabledEdgeKinds: Set<EdgeKind> | null = null;
  private parentByNodeId = new Map<string, string>();
  private _minimapNodesGfx: Graphics | null = null;    // static node dots
  private _minimapViewportGfx: Graphics | null = null;  // viewport rectangle
  private _minimapLayoutVersion: LayoutResult | null = null;
  private resizeObserver: ResizeObserver;
  private containerEl: HTMLElement;
  private initialized = false;
  private selectedNodeId: string | null = null;
  private currentLOD: LODLevel = "detail";
  private lastLayout: LayoutResult | null = null;
  private currentGraph: CodeGraph | null = null;
  private currentVisibleNodes: Set<string> = new Set();
  private edgeRedrawFrame: number | null = null;
  private _viewportDirty = false;
  private _viewportRafId: number | null = null;
  private _layoutRequestId = 0;

  // Drag state
  private dragTarget: {
    nodeId: string;
    offsetX: number;
    offsetY: number;
    // Track descendants to move with parent
    descendants: Array<{ nodeId: string; relX: number; relY: number }>;
  } | null = null;

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

    this.containerLayer = new Container();
    this.edgeLayer = new Container();
    this.edgeLayer.eventMode = "none";
    this.componentLayer = new Container();

    this.viewport.addChild(this.containerLayer);
    this.viewport.addChild(this.edgeLayer);
    this.viewport.addChild(this.componentLayer);

    this.app.stage.addChild(this.viewport);

    // Track viewport changes for LOD and culling (throttled to one per frame)
    this.viewport.on("moved", () => {
      if (!this._viewportDirty) {
        this._viewportDirty = true;
        this._viewportRafId = requestAnimationFrame(() => {
          this._viewportRafId = null;
          this._viewportDirty = false;
          if (!this.destroyed && this.initialized) {
            this.onViewportChanged();
          }
        });
      }
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

      // Always show all nodes - just adjust label visibility for performance
      display.container.visible = true;

      if (node.type === "CodeBlock") {
        // Hide code block labels when very zoomed out
        display.label.visible = this.currentLOD === "detail";
      } else if (node.type === "File") {
        // Hide file labels at minimap zoom
        display.label.visible = this.currentLOD !== "minimap";
      } else {
        // Directory labels always visible except at extreme zoom
        display.label.visible = this.currentLOD !== "minimap";
      }
    }

    // Redraw edges with new LOD opacity/width
    this.redrawEdgesWithHighlight();
  }

  updateGraph(
    graph: CodeGraph,
    expandedNodes: Set<string>,
    visibleNodes: Set<string>,
    enabledEdgeKinds?: Set<EdgeKind>
  ) {
    const codeBlocks = Object.values(graph.nodes).filter(n => n.type === "CodeBlock").length;
    console.log("PixiRenderer.updateGraph called:", {
      nodes: Object.keys(graph.nodes).length,
      edges: graph.edges.length,
      codeBlocks,
      expanded: expandedNodes.size,
      visible: visibleNodes.size,
      enabledEdgeKinds: enabledEdgeKinds?.size,
      initialized: this.initialized,
    });

    if (!this.initialized) {
      this.pendingUpdate = { graph, expanded: expandedNodes, visible: visibleNodes };
      console.log("Pixi not initialized, queuing update");
      return;
    }

    this.currentGraph = graph;
    this.currentVisibleNodes = visibleNodes;
    this.currentEnabledEdgeKinds = enabledEdgeKinds ?? null;
    this.parentByNodeId = this.buildParentMap(graph);

    // Run layout with edge kind filtering (with cancellation token for stale results)
    const requestId = ++this._layoutRequestId;
    layoutGraph(graph, expandedNodes, visibleNodes, enabledEdgeKinds).then((layout) => {
      if (requestId !== this._layoutRequestId) return; // stale — discard
      this.lastLayout = layout;
      this.renderFromLayout(graph, layout, expandedNodes, visibleNodes);
    });
  }

  /**
   * Update visibility of nodes and edges without full relayout.
   * Called when visibleNodes changes but we don't want to recompute layout.
   */
  updateVisibility(visibleNodes: Set<string>) {
    this.currentVisibleNodes = visibleNodes;

    // Update node visibility
    for (const [nodeId, display] of this.nodeDisplays) {
      display.container.visible = visibleNodes.has(nodeId);
    }

    // Redraw edges filtering out hidden nodes
    this.redrawEdgesWithVisibility();
  }

  private redrawEdgesWithVisibility() {
    // Use the unified edge redraw method which handles visibility, highlighting, and LOD
    this.redrawEdgesWithHighlight();
  }

  private renderFromLayout(
    graph: CodeGraph,
    layout: LayoutResult,
    expandedNodes: Set<string>,
    _visibleNodes: Set<string>
  ) {
    console.log("renderFromLayout:", {
      graphEdges: graph.edges.length,
      layoutEdges: layout.edges.length,
      layoutNodes: Object.keys(layout.nodes).length,
    });

    // Clear existing displays
    for (const [, display] of this.nodeDisplays) {
      display.container.destroy({ children: true });
    }
    this.nodeDisplays.clear();

    if (this.edgeGraphics) {
      this.edgeGraphics.destroy();
      this.edgeGraphics = null;
    }

    // Create node displays from layout
    for (const [nodeId, pos] of Object.entries(layout.nodes)) {
      const node = graph.nodes[nodeId];
      if (!node) continue;

      this.createNodeDisplay(nodeId, node, pos, expandedNodes.has(nodeId));
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

      // Start drag - collect all descendants to move together
      const local = this.viewport.toLocal(e.global);
      const descendants = this.collectDescendants(nodeId, container.x, container.y);
      this.dragTarget = {
        nodeId,
        offsetX: local.x - container.x,
        offsetY: local.y - container.y,
        descendants,
      };
    });

    // Drag
    container.on("globalpointermove", (e) => {
      if (this.dragTarget && this.dragTarget.nodeId === nodeId) {
        const local = this.viewport.toLocal(e.global);
        const newX = local.x - this.dragTarget.offsetX;
        const newY = local.y - this.dragTarget.offsetY;

        // Move the dragged node
        container.x = newX;
        container.y = newY;
        this.syncDisplayBounds(nodeId);

        // Move all descendants relative to the parent
        for (const desc of this.dragTarget.descendants) {
          const descDisplay = this.nodeDisplays.get(desc.nodeId);
          if (descDisplay) {
            descDisplay.container.x = newX + desc.relX;
            descDisplay.container.y = newY + desc.relY;
            this.syncDisplayBounds(desc.nodeId);
          }
        }

        this.resizeAncestorChain(nodeId);
        this.scheduleEdgeRedraw();
      }
    });

    container.on("pointerup", () => {
      if (this.dragTarget) {
        this.dragTarget = null;
        this.flushEdgeRedraw();
      }
    });

    container.on("pointerupoutside", () => {
      if (this.dragTarget) {
        this.dragTarget = null;
        this.flushEdgeRedraw();
      }
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

    this.getNodeLayer(node).addChild(container);

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
    console.log("drawEdges called with", layout.edges.length, "edges");
    if (layout.edges.length === 0) return;

    // Store edge data for redrawing after drag and build node-to-edge index map
    this.nodeToEdgeIndices.clear();
    this.edgeData = layout.edges.map((e, idx) => {
      // Build node to edge indices map
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

    this.rebuildHoveredEdgeIndices();
    this.redrawEdgesWithHighlight();
  }

  /**
   * Redraw all edges with current hover/LOD state
   */
  private redrawEdgesWithHighlight() {
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
    const lodOpacityMultiplier = this.getLODEdgeOpacity();

    // Draw edges (non-highlighted first, then highlighted on top)
    const edgesToDraw = this.edgeData.map((edge, idx) => ({ edge, idx }));

    // Sort so highlighted edges are drawn last (on top)
    if (this.hoveredNodeId) {
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
      if (!this.currentVisibleNodes.has(edge.source) || !this.currentVisibleNodes.has(edge.target)) {
        continue;
      }

      // Skip edge kinds that should be hidden at current LOD (unless highlighting)
      if (!this.hoveredNodeId && this.shouldHideEdgeKindAtLOD(edge.kind)) {
        continue;
      }

      const sourceDisplay = this.nodeDisplays.get(edge.source);
      const targetDisplay = this.nodeDisplays.get(edge.target);

      if (!sourceDisplay || !targetDisplay || edge.originalPoints.length < 2) continue;

      const color = parseInt(edge.color.replace("#", ""), 16);
      const style = edge.kind ? EDGE_STYLES[edge.kind] : DEFAULT_EDGE_STYLE;
      const sourceBox = {
        x: sourceDisplay.container.x,
        y: sourceDisplay.container.y,
        width: sourceDisplay.layoutPos.width,
        height: sourceDisplay.layoutPos.height,
      };
      const targetBox = {
        x: targetDisplay.container.x,
        y: targetDisplay.container.y,
        width: targetDisplay.layoutPos.width,
        height: targetDisplay.layoutPos.height,
      };
      const sourceDx = sourceDisplay.container.x - sourceDisplay.layoutPos.x;
      const sourceDy = sourceDisplay.container.y - sourceDisplay.layoutPos.y;
      const targetDx = targetDisplay.container.x - targetDisplay.layoutPos.x;
      const targetDy = targetDisplay.container.y - targetDisplay.layoutPos.y;
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

      if (this.hoveredNodeId) {
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
        width = style.width * this.getLODEdgeWidthMultiplier();
      }

      // Skip edges that are too faint
      if (alpha < 0.05) continue;

      this.drawEdgePath(gfx, points, Math.max(4, width * 2.2));
      gfx.stroke({
        color,
        width,
        alpha,
        cap: "round",
        join: "round",
      });

      if (this.currentLOD !== "minimap") {
        this.drawEdgeStartCap(gfx, points[0], color, alpha, width);
      }

      this.drawEdgeArrowhead(
        gfx,
        points[points.length - 2],
        points[points.length - 1],
        color,
        alpha,
        width
      );
    }

    this.edgeLayer.addChild(gfx);
    this.edgeGraphics = gfx;
  }

  private getNodeLayer(node: CodeNode): Container {
    return node.type === "CodeBlock" ? this.componentLayer : this.containerLayer;
  }

  /**
   * Get opacity multiplier based on current LOD level and settings
   */
  private getLODEdgeOpacity(): number {
    const settings = useViewportStore.getState().edgeLODSettings;
    switch (this.currentLOD) {
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
  private shouldHideEdgeKindAtLOD(kind: EdgeKind | null): boolean {
    if (!kind) return false;
    const settings = useViewportStore.getState().edgeLODSettings;
    if (this.currentLOD === "overview" && settings.hideAtOverview.has(kind)) {
      return true;
    }
    return false;
  }

  /**
   * Get width multiplier based on current LOD level
   */
  private getLODEdgeWidthMultiplier(): number {
    switch (this.currentLOD) {
      case "minimap":
        return 0.5;
      case "overview":
        return 0.75;
      case "detail":
      default:
        return 1.0;
    }
  }

  /**
   * Set the hovered node and update edge highlighting
   */
  setHoveredNode(nodeId: string | null) {
    if (this.hoveredNodeId === nodeId) return;
    this.hoveredNodeId = nodeId;
    this.rebuildHoveredEdgeIndices();
    this.redrawEdgesWithHighlight();
  }

  private rebuildHoveredEdgeIndices() {
    this.highlightedEdgeIndices.clear();

    if (!this.hoveredNodeId) {
      return;
    }

    for (const nodeId of this.collectNodeSubtreeIds(this.hoveredNodeId)) {
      const indices = this.nodeToEdgeIndices.get(nodeId);
      if (!indices) continue;

      for (const idx of indices) {
        this.highlightedEdgeIndices.add(idx);
      }
    }
  }

  private collectNodeSubtreeIds(nodeId: string): Set<string> {
    const result = new Set<string>();
    const stack = [nodeId];

    while (stack.length > 0) {
      const currentId = stack.pop();
      if (!currentId || result.has(currentId)) continue;

      result.add(currentId);

      const node = this.currentGraph?.nodes[currentId];
      if (!node) continue;

      for (const childId of node.children) {
        stack.push(childId);
      }
    }

    return result;
  }

  private buildParentMap(graph: CodeGraph): Map<string, string> {
    const parentMap = new Map<string, string>();

    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      for (const childId of node.children) {
        parentMap.set(childId, nodeId);
      }
    }

    return parentMap;
  }

  private getParentNodeId(nodeId: string): string | null {
    return this.parentByNodeId.get(nodeId) ?? null;
  }

  private resizeAncestorChain(nodeId: string) {
    let currentId = this.getParentNodeId(nodeId);

    while (currentId) {
      this.resizeNodeToFitChildren(currentId);
      currentId = this.getParentNodeId(currentId);
    }
  }

  private resizeNodeToFitChildren(nodeId: string) {
    const display = this.nodeDisplays.get(nodeId);
    const node = this.currentGraph?.nodes[nodeId];
    if (!display || !node) {
      return;
    }

    const padding = this.getNodePadding(node);
    const minSize = this.getMinimumNodeSize(node);
    let nextX = display.container.x;
    let nextY = display.container.y;
    let nextWidth = minSize.width;
    let nextHeight = minSize.height;
    let maxChildRight = nextX + minSize.width - padding.right;
    let maxChildBottom = nextY + minSize.height - padding.bottom;

    for (const childId of node.children) {
      if (!this.currentVisibleNodes.has(childId)) continue;

      const childDisplay = this.nodeDisplays.get(childId);
      if (!childDisplay) continue;

      nextX = Math.min(nextX, childDisplay.container.x - padding.left);
      nextY = Math.min(nextY, childDisplay.container.y - padding.top);
      maxChildRight = Math.max(
        maxChildRight,
        childDisplay.container.x + childDisplay.layoutPos.width
      );
      maxChildBottom = Math.max(
        maxChildBottom,
        childDisplay.container.y + childDisplay.layoutPos.height
      );
    }

    nextWidth = Math.max(nextWidth, Math.ceil(maxChildRight - nextX + padding.right));
    nextHeight = Math.max(nextHeight, Math.ceil(maxChildBottom - nextY + padding.bottom));

    if (
      nextX === display.container.x &&
      nextY === display.container.y &&
      nextWidth === display.layoutPos.width &&
      nextHeight === display.layoutPos.height
    ) {
      return;
    }

    display.container.x = nextX;
    display.container.y = nextY;
    display.layoutPos.width = nextWidth;
    display.layoutPos.height = nextHeight;
    this.redrawNodeBg(display, this.selectedNodeId === nodeId);
    this.updateNodeLabelWrap(display);
    this.syncDisplayBounds(nodeId);
  }

  private getMinimumNodeSize(node: CodeNode): { width: number; height: number } {
    switch (node.type) {
      case "Directory":
        return { width: 200, height: 60 };
      case "File":
        return { width: 180, height: 40 };
      case "CodeBlock":
        return { width: 160, height: 32 };
    }
  }

  private getNodePadding(node: CodeNode): NodePadding {
    if (node.children.length === 0) {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }

    return { top: 30, right: 10, bottom: 10, left: 10 };
  }

  private updateNodeLabelWrap(display: NodeDisplay) {
    display.label.style.wordWrapWidth = Math.max(display.layoutPos.width - 16, 40);
  }

  private syncDisplayBounds(nodeId: string) {
    const display = this.nodeDisplays.get(nodeId);
    if (!display) {
      return;
    }

    if (this.lastLayout?.nodes[nodeId]) {
      this.lastLayout.nodes[nodeId] = {
        ...this.lastLayout.nodes[nodeId],
        x: display.container.x,
        y: display.container.y,
        width: display.layoutPos.width,
        height: display.layoutPos.height,
      };
    }
  }

  /**
   * Refresh edges (e.g., when LOD settings change)
   */
  refreshEdges() {
    this.redrawEdgesWithHighlight();
  }

  /**
   * Redraw edges using current node positions (called after dragging)
   * Uses the unified highlight system
   */
  private redrawEdgesFromCurrentPositions() {
    this.redrawEdgesWithHighlight();
  }

  private scheduleEdgeRedraw() {
    if (this.edgeRedrawFrame !== null) {
      return;
    }

    this.edgeRedrawFrame = window.requestAnimationFrame(() => {
      this.edgeRedrawFrame = null;
      if (this.destroyed || !this.initialized) {
        return;
      }
      this.redrawEdgesFromCurrentPositions();
    });
  }

  private flushEdgeRedraw() {
    if (this.edgeRedrawFrame !== null) {
      window.cancelAnimationFrame(this.edgeRedrawFrame);
      this.edgeRedrawFrame = null;
    }
    this.redrawEdgesFromCurrentPositions();
  }

  private drawEdgePath(gfx: Graphics, points: Point[], cornerRadius: number) {
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

  private drawEdgeStartCap(
    gfx: Graphics,
    point: Point,
    color: number,
    alpha: number,
    width: number
  ) {
    const radius = Math.max(2, width * 0.95);
    gfx.circle(point.x, point.y, radius);
    gfx.fill({ color, alpha: Math.min(1, alpha * 0.95) });
  }

  private drawEdgeArrowhead(
    gfx: Graphics,
    from: Point,
    to: Point,
    color: number,
    alpha: number,
    width: number
  ) {
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

  /**
   * Compute minimap geometry (world bounds and scale) from lastLayout.
   * Returns null if no layout / no nodes.
   */
  private getMinimapGeometry() {
    if (!this.lastLayout || this.nodeDisplays.size === 0) return null;

    const mmWidth = 150;
    const mmHeight = 100;
    const mmX = this.containerEl.clientWidth - mmWidth - 10;
    const mmY = this.containerEl.clientHeight - mmHeight - 10;

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

    return { mmX, mmY, mmWidth, mmHeight, minX, minY, mmScale };
  }

  /**
   * Rebuild the static minimap nodes layer (background + node rectangles).
   * Only called when the layout reference changes.
   */
  private rebuildMinimapNodes() {
    if (this._minimapLayoutVersion === this.lastLayout) return;
    this._minimapLayoutVersion = this.lastLayout;

    if (this._minimapNodesGfx) {
      this._minimapNodesGfx.destroy();
      this._minimapNodesGfx = null;
    }

    const geo = this.getMinimapGeometry();
    if (!geo) return;

    const gfx = new Graphics();

    // Background
    gfx.roundRect(geo.mmX, geo.mmY, geo.mmWidth, geo.mmHeight, 4);
    gfx.fill({ color: 0x1e293b, alpha: 0.85 });
    gfx.stroke({ color: 0x334155, width: 1 });

    // Draw nodes as small rectangles
    for (const pos of Object.values(this.lastLayout!.nodes)) {
      const rx = geo.mmX + 4 + (pos.x - geo.minX) * geo.mmScale;
      const ry = geo.mmY + 4 + (pos.y - geo.minY) * geo.mmScale;
      const rw = Math.max(pos.width * geo.mmScale, 2);
      const rh = Math.max(pos.height * geo.mmScale, 1);

      gfx.rect(rx, ry, rw, rh);
      gfx.fill({ color: 0x3b82f6, alpha: 0.5 });
    }

    this.app.stage.addChild(gfx);
    this._minimapNodesGfx = gfx;
  }

  private updateMinimap() {
    // Rebuild static node layer only when layout changes
    this.rebuildMinimapNodes();

    // Destroy/recreate only the viewport rectangle overlay
    if (this._minimapViewportGfx) {
      this._minimapViewportGfx.destroy();
      this._minimapViewportGfx = null;
    }

    const geo = this.getMinimapGeometry();
    if (!geo) return;

    const vpGfx = new Graphics();
    const vp = this.viewport.getVisibleBounds();
    const vpRx = geo.mmX + 4 + (vp.x - geo.minX) * geo.mmScale;
    const vpRy = geo.mmY + 4 + (vp.y - geo.minY) * geo.mmScale;
    const vpRw = vp.width * geo.mmScale;
    const vpRh = vp.height * geo.mmScale;

    vpGfx.rect(vpRx, vpRy, vpRw, vpRh);
    vpGfx.stroke({ color: 0x60a5fa, width: 1.5 });

    this.app.stage.addChild(vpGfx);
    this._minimapViewportGfx = vpGfx;
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

  /**
   * Collect all descendant node IDs with their positions relative to the parent.
   */
  private collectDescendants(
    parentId: string,
    parentX: number,
    parentY: number
  ): Array<{ nodeId: string; relX: number; relY: number }> {
    const result: Array<{ nodeId: string; relX: number; relY: number }> = [];
    if (!this.currentGraph) return result;

    const collectChildren = (nodeId: string) => {
      const node = this.currentGraph?.nodes[nodeId];
      if (!node) return;

      for (const childId of node.children) {
        const childDisplay = this.nodeDisplays.get(childId);
        if (childDisplay) {
          result.push({
            nodeId: childId,
            relX: childDisplay.container.x - parentX,
            relY: childDisplay.container.y - parentY,
          });
          // Recursively collect grandchildren
          collectChildren(childId);
        }
      }
    };

    collectChildren(parentId);
    return result;
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
    if (this.edgeRedrawFrame !== null) {
      window.cancelAnimationFrame(this.edgeRedrawFrame);
      this.edgeRedrawFrame = null;
    }
    if (this._viewportRafId !== null) {
      cancelAnimationFrame(this._viewportRafId);
      this._viewportRafId = null;
    }
    this.resizeObserver.disconnect();
    if (!this.initialized) return;
    if (this._minimapNodesGfx) {
      this._minimapNodesGfx.destroy();
    }
    if (this._minimapViewportGfx) {
      this._minimapViewportGfx.destroy();
    }
    try {
      this.app.destroy(true, { children: true });
    } catch {
      // Pixi may already be partially torn down
    }
  }
}
