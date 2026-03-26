import { Application, Container } from "pixi.js";
import { Viewport } from "pixi-viewport";
import type { CodeGraph, CodeNode, EdgeKind } from "../../api/types";
import { layoutGraph, type LayoutResult, type LayoutNodePosition } from "../layout/elkLayout";
import { useGraphStore } from "../../stores/graphStore";
import { useViewportStore, type LODLevel } from "../../stores/viewportStore";
import { useDebugStore } from "../../stores/debugStore";
import { buildParentMap } from "../utils/graphUtils";
import { EdgeDrawingManager, type NodeDisplayRef } from "./edgeDrawing";
import { MinimapRenderer } from "./minimapRenderer";
import { DragManager, redrawNodeBg, syncDisplayBounds } from "./dragManager";
import {
  createNodeDisplay,
  getNodeLayer,
  type NodeDisplay,
} from "./nodeCreation";

export class PixiRenderer {
  private app: Application;
  private viewport!: Viewport;
  private containerLayer!: Container;
  private edgeLayer!: Container;
  private componentLayer!: Container;
  private nodeDisplays = new Map<string, NodeDisplay>();
  private hoveredNodeId: string | null = null;
  private currentEnabledEdgeKinds: Set<EdgeKind> | null = null;
  private parentByNodeId = new Map<string, string>();
  private resizeObserver: ResizeObserver;
  private containerEl: HTMLElement;
  private initialized = false;
  private selectedNodeId: string | null = null;
  private currentLOD: LODLevel = "detail";
  private lastLayout: LayoutResult | null = null;
  private currentGraph: CodeGraph | null = null;
  private currentVisibleNodes: Set<string> = new Set();
  private _viewportDirty = false;
  private _viewportRafId: number | null = null;
  private _layoutRequestId = 0;

  private pendingUpdate: {
    graph: CodeGraph;
    expanded: Set<string>;
    visible: Set<string>;
  } | null = null;

  private initPromise: Promise<void>;
  private destroyed = false;

  // Extracted sub-managers
  private edgeManager = new EdgeDrawingManager();
  private minimapRenderer = new MinimapRenderer();
  private dragManager = new DragManager();

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
      if (!this.dragManager.dragTarget) {
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
    this.minimapRenderer.updateMinimap(
      this.app,
      this.viewport,
      this.lastLayout,
      this.nodeDisplays.size,
      this.containerEl.clientWidth,
      this.containerEl.clientHeight
    );
  }

  private updateLODVisibility() {
    for (const [_nodeId, display] of this.nodeDisplays) {
      const node = display.nodeData;

      // Always show all nodes - just adjust label visibility for performance
      display.container.visible = true;

      if (node.type === "CodeBlock") {
        display.label.visible = this.currentLOD === "detail";
      } else if (node.type === "File") {
        display.label.visible = this.currentLOD !== "minimap";
      } else {
        display.label.visible = this.currentLOD !== "minimap";
      }
    }

    // Redraw edges with new LOD opacity/width
    this.triggerEdgeRedraw();
  }

  updateGraph(
    graph: CodeGraph,
    expandedNodes: Set<string>,
    visibleNodes: Set<string>,
    enabledEdgeKinds?: Set<EdgeKind>
  ) {
    if (import.meta.env.DEV) {
      const codeBlocks = Object.values(graph.nodes).filter(n => n.type === "CodeBlock").length;
      useDebugStore.getState().addLog(
        `updateGraph: nodes=${Object.keys(graph.nodes).length}, edges=${graph.edges.length}, codeBlocks=${codeBlocks}, expanded=${expandedNodes.size}, visible=${visibleNodes.size}`
      );
    }

    if (!this.initialized) {
      this.pendingUpdate = { graph, expanded: expandedNodes, visible: visibleNodes };
      if (import.meta.env.DEV) {
        useDebugStore.getState().addLog("Pixi not initialized, queuing update");
      }
      return;
    }

    this.currentGraph = graph;
    this.currentVisibleNodes = visibleNodes;
    this.currentEnabledEdgeKinds = enabledEdgeKinds ?? null;
    this.parentByNodeId = buildParentMap(graph);

    // Run layout with edge kind filtering (with cancellation token for stale results)
    const requestId = ++this._layoutRequestId;
    layoutGraph(graph, expandedNodes, visibleNodes, enabledEdgeKinds).then((layout) => {
      if (requestId !== this._layoutRequestId) return; // stale -- discard
      this.lastLayout = layout;
      this.renderFromLayout(graph, layout, expandedNodes, visibleNodes);
    });
  }

  /**
   * Update visibility of nodes and edges without full relayout.
   */
  updateVisibility(visibleNodes: Set<string>) {
    this.currentVisibleNodes = visibleNodes;

    for (const [nodeId, display] of this.nodeDisplays) {
      display.container.visible = visibleNodes.has(nodeId);
    }

    this.triggerEdgeRedraw();
  }

  private renderFromLayout(
    graph: CodeGraph,
    layout: LayoutResult,
    expandedNodes: Set<string>,
    _visibleNodes: Set<string>
  ) {
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(
        `renderFromLayout: graphEdges=${graph.edges.length}, layoutEdges=${layout.edges.length}, layoutNodes=${Object.keys(layout.nodes).length}`
      );
    }

    // Clear existing displays
    for (const [, display] of this.nodeDisplays) {
      display.container.destroy({ children: true });
    }
    this.nodeDisplays.clear();
    this.edgeManager.destroyEdgeGraphics();

    // Create node displays from layout
    for (const [nodeId, pos] of Object.entries(layout.nodes)) {
      const node = graph.nodes[nodeId];
      if (!node) continue;

      this.addNodeDisplay(nodeId, node, pos, expandedNodes.has(nodeId));
    }

    // Draw edges
    this.edgeManager.buildEdgeData(layout);
    this.rebuildHoveredEdgeIndices();
    this.triggerEdgeRedraw();

    // Initial LOD update
    this.updateLODVisibility();

    // Fit viewport to content
    if (this.nodeDisplays.size > 0) {
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

  /**
   * Create and register a node display, wiring up all interaction handlers.
   */
  private addNodeDisplay(
    nodeId: string,
    node: CodeNode,
    pos: LayoutNodePosition,
    _isExpanded: boolean
  ) {
    const display = createNodeDisplay(nodeId, node, pos, this.selectedNodeId);

    // Click handler
    display.container.on("pointerdown", (e) => {
      e.stopPropagation();
      useGraphStore.getState().setSelectedNode(nodeId);

      const local = this.viewport.toLocal(e.global);
      const descendants = this.dragManager.collectDescendants(
        nodeId,
        display.container.x,
        display.container.y,
        this.currentGraph,
        this.nodeDisplays
      );
      this.dragManager.dragTarget = {
        nodeId,
        offsetX: local.x - display.container.x,
        offsetY: local.y - display.container.y,
        descendants,
      };
    });

    // Drag
    display.container.on("globalpointermove", (e) => {
      const dt = this.dragManager.dragTarget;
      if (dt && dt.nodeId === nodeId) {
        const local = this.viewport.toLocal(e.global);
        const newX = local.x - dt.offsetX;
        const newY = local.y - dt.offsetY;

        display.container.x = newX;
        display.container.y = newY;
        syncDisplayBounds(nodeId, display, this.lastLayout);

        for (const desc of dt.descendants) {
          const descDisplay = this.nodeDisplays.get(desc.nodeId);
          if (descDisplay) {
            descDisplay.container.x = newX + desc.relX;
            descDisplay.container.y = newY + desc.relY;
            syncDisplayBounds(desc.nodeId, descDisplay, this.lastLayout);
          }
        }

        this.dragManager.resizeAncestorChain(
          nodeId,
          this.parentByNodeId,
          this.currentGraph,
          this.nodeDisplays,
          this.currentVisibleNodes,
          this.selectedNodeId,
          this.lastLayout
        );
        this.edgeManager.scheduleEdgeRedraw(() => {
          if (!this.destroyed && this.initialized) {
            this.triggerEdgeRedraw();
          }
        });
      }
    });

    display.container.on("pointerup", () => {
      if (this.dragManager.dragTarget) {
        this.dragManager.dragTarget = null;
        this.edgeManager.flushEdgeRedraw(() => this.triggerEdgeRedraw());
      }
    });

    display.container.on("pointerupoutside", () => {
      if (this.dragManager.dragTarget) {
        this.dragManager.dragTarget = null;
        this.edgeManager.flushEdgeRedraw(() => this.triggerEdgeRedraw());
      }
    });

    // Double-click to expand/collapse
    let lastClickTime = 0;
    display.container.on("pointertap", () => {
      const now = Date.now();
      if (now - lastClickTime < 350) {
        useGraphStore.getState().toggleExpanded(nodeId);
      }
      lastClickTime = now;
    });

    // Hover
    display.container.on("pointerover", () => {
      useGraphStore.getState().setHoveredNode(nodeId);
      display.bg.tint = 0xdddddd;
    });
    display.container.on("pointerout", () => {
      useGraphStore.getState().setHoveredNode(null);
      display.bg.tint = 0xffffff;
    });

    getNodeLayer(node, this.containerLayer, this.componentLayer).addChild(display.container);

    this.nodeDisplays.set(nodeId, display);
  }

  /**
   * Set the hovered node and update edge highlighting.
   *
   * Uses the two-layer optimisation in EdgeDrawingManager: on hover we only
   * rebuild the lightweight highlight layer instead of destroying and
   * recreating all edge graphics.
   */
  setHoveredNode(nodeId: string | null) {
    if (this.hoveredNodeId === nodeId) return;
    this.hoveredNodeId = nodeId;
    this.rebuildHoveredEdgeIndices();

    // Try a hover-only update (highlight layer only).
    // Falls back to a full redraw if the base layer doesn't exist yet.
    const handled = this.edgeManager.setHoveredNode(nodeId);
    if (!handled) {
      this.triggerEdgeRedraw();
    }
  }

  private rebuildHoveredEdgeIndices() {
    this.edgeManager.highlightedEdgeIndices.clear();

    if (!this.hoveredNodeId) {
      return;
    }

    for (const id of this.collectNodeSubtreeIds(this.hoveredNodeId)) {
      const indices = this.edgeManager.nodeToEdgeIndices.get(id);
      if (!indices) continue;

      for (const idx of indices) {
        this.edgeManager.highlightedEdgeIndices.add(idx);
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

  setSelectedNode(nodeId: string | null) {
    const prev = this.selectedNodeId;
    this.selectedNodeId = nodeId;

    if (prev) {
      const display = this.nodeDisplays.get(prev);
      if (display) {
        redrawNodeBg(display, false);
      }
    }

    if (nodeId) {
      const display = this.nodeDisplays.get(nodeId);
      if (display) {
        redrawNodeBg(display, true);
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
   * Refresh edges (e.g., when LOD settings change)
   */
  refreshEdges() {
    this.triggerEdgeRedraw();
  }

  /**
   * Unified method to trigger an edge redraw with current state.
   */
  private triggerEdgeRedraw() {
    const getRef = (nodeId: string): NodeDisplayRef | null => {
      const d = this.nodeDisplays.get(nodeId);
      if (!d) return null;
      return {
        containerX: d.container.x,
        containerY: d.container.y,
        layoutWidth: d.layoutPos.width,
        layoutHeight: d.layoutPos.height,
        layoutX: d.layoutPos.x,
        layoutY: d.layoutPos.y,
      };
    };

    this.edgeManager.redrawEdgesWithHighlight(
      this.edgeLayer,
      this.hoveredNodeId,
      this.currentLOD,
      this.currentVisibleNodes,
      getRef
    );
  }

  destroy() {
    this.destroyed = true;
    this.edgeManager.destroyEdgeGraphics();
    if (this._viewportRafId !== null) {
      cancelAnimationFrame(this._viewportRafId);
      this._viewportRafId = null;
    }
    this.resizeObserver.disconnect();
    if (!this.initialized) return;
    this.minimapRenderer.destroy();
    try {
      this.app.destroy(true, { children: true });
    } catch {
      // Pixi may already be partially torn down
    }
  }
}
