import { Application, Container } from "pixi.js";
import { Viewport } from "pixi-viewport";
import type { CodeGraph, CodeNode, EdgeKind } from "../../api/types";
import { layoutGraph, type LayoutResult, type LayoutNodePosition } from "../layout/elkLayout";
import { useGraphStore } from "../../stores/graphStore";
import {
  EMPTY_SELECTION,
  highlightDimsBaseLayer,
  resolveHighlightSource,
  selectionFromStore,
  selectionIds,
  type HighlightSource,
  type SelectionState,
} from "../../stores/selectionModel";
import { useViewportStore, type LODLevel } from "../../stores/viewportStore";
import { useDebugStore } from "../../stores/debugStore";
import { useEdgeLegendStore } from "../../stores/edgeLegendStore";
import { buildParentMap } from "../utils/graphUtils";
import { pointToPolylineDistance } from "../layout/edgeGeometry";
import { EdgeDrawingManager, type NodeDisplayRef } from "./edgeDrawing";
import type { EdgeDatum } from "./types";
import { MinimapRenderer } from "./minimapRenderer";
import { DragManager, redrawNodeBg, syncDisplayBounds } from "./dragManager";
import {
  createNodeDisplay,
  getNodeLayer,
  type NodeDisplay,
} from "./nodeCreation";
import {
  edgeEndpointIds,
  emphasisRedrawIds,
  resolveNodeEmphasis,
  type NodeEmphasis,
} from "./nodeEmphasis";

/** Window within which two taps count as a double-click. */
const DOUBLE_TAP_MS = 350;

/** Pointer hit-test radius for edges, in screen pixels. */
const EDGE_HIT_RADIUS_PX = 8;

export class PixiRenderer {
  private app: Application;
  private viewport!: Viewport;
  private containerLayer!: Container;
  private edgeLayer!: Container;
  private componentLayer!: Container;
  private nodeDisplays = new Map<string, NodeDisplay>();
  private hoveredNodeId: string | null = null;
  /** Endpoints of the edge currently under the pointer (emphasised borders). */
  private hoveredEdgeEndpoints: ReadonlySet<string> = new Set<string>();
  private currentEnabledEdgeKinds: Set<EdgeKind> | null = null;
  private parentByNodeId = new Map<string, string>();
  private resizeObserver: ResizeObserver;
  private containerEl: HTMLElement;
  private initialized = false;
  /** Mirror of the store's selection; also the pinned edge highlight. */
  private selection: SelectionState = EMPTY_SELECTION;
  private currentLOD: LODLevel = "detail";
  private lastLayout: LayoutResult | null = null;
  private currentGraph: CodeGraph | null = null;
  private currentVisibleNodes: Set<string> = new Set();
  private _viewportDirty = false;
  private _viewportRafId: number | null = null;
  private _layoutRequestId = 0;
  private _edgeHoverRafId: number | null = null;
  /** Identity + time of the last tap that landed on an edge (double-click pairing). */
  private lastEdgeTapKey: string | null = null;
  private lastEdgeTapTime = 0;

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

    // Click on empty space to deselect (which also drops the pinned highlight)
    this.viewport.on("pointerdown", () => {
      if (!this.dragManager.dragTarget) {
        useGraphStore.getState().clearSelection();
      }
    });

    // Edge hover detection (throttled to once per frame)
    this.viewport.on("pointermove", (e) => {
      if (this._edgeHoverRafId !== null) return;
      this._edgeHoverRafId = requestAnimationFrame(() => {
        this._edgeHoverRafId = null;
        if (this.destroyed || !this.initialized) return;
        // Node hover takes priority over edge hover
        if (this.hoveredNodeId) {
          useGraphStore.getState().setHoveredEdge(null);
          return;
        }
        const closestEdge = this.hitTestEdge(e.global);
        if (closestEdge && closestEdge.kind) {
          const sourceNode = this.currentGraph?.nodes[closestEdge.source];
          const targetNode = this.currentGraph?.nodes[closestEdge.target];
          useGraphStore.getState().setHoveredEdge({
            kind: closestEdge.kind,
            sourceId: closestEdge.source,
            targetId: closestEdge.target,
            sourceName: sourceNode?.name || closestEdge.source,
            targetName: targetNode?.name || closestEdge.target,
            count: closestEdge.count || 1,
          });
        } else {
          useGraphStore.getState().setHoveredEdge(null);
        }
      });
    });

    // Double-click an AGGREGATED edge (count > 1) to drill into it: the store
    // fetches the underlying edges behind that one aggregate and focuses them.
    // Pixi has no dblclick, so taps are paired manually -- both taps must land on
    // the same edge within the double-click window, which leaves single-click
    // (deselect) and hover behavior untouched.
    this.viewport.on("pointertap", (e) => {
      if (this.destroyed || !this.initialized) return;
      // Node interactions win, exactly as they do for edge hover.
      if (this.hoveredNodeId || this.dragManager.dragTarget) return;

      const edge = this.hitTestEdge(e.global);
      if (!edge) {
        this.lastEdgeTapKey = null;
        return;
      }
      const key = `${edge.source}\u0000${edge.target}\u0000${edge.kind ?? ""}`;
      const now = Date.now();
      const isSecondTap =
        this.lastEdgeTapKey === key && now - this.lastEdgeTapTime < DOUBLE_TAP_MS;

      if (isSecondTap) {
        this.lastEdgeTapKey = null;
        this.lastEdgeTapTime = 0;
        if ((edge.count ?? 1) > 1) {
          // enterEdgeFocus handles its own IPC failures; nothing to await here.
          void useGraphStore.getState().enterEdgeFocus(edge.source, edge.target);
        }
        return;
      }
      this.lastEdgeTapKey = key;
      this.lastEdgeTapTime = now;
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
    enabledEdgeKinds?: Set<EdgeKind>,
    hideAmbiguousEdges = false
  ) {
    if (import.meta.env.DEV) {
      const codeBlocks = Object.values(graph.nodes).filter(n => n.type === "CodeBlock").length;
      useDebugStore.getState().addLog(
        `updateGraph: nodes=${Object.keys(graph.nodes).length}, edges=${graph.edgeCount}, codeBlocks=${codeBlocks}, expanded=${expandedNodes.size}, visible=${visibleNodes.size}`
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
    layoutGraph(graph, expandedNodes, visibleNodes, enabledEdgeKinds, hideAmbiguousEdges).then((layout) => {
      if (requestId !== this._layoutRequestId) return; // stale -- discard
      this.lastLayout = layout;
      // Publish per-kind view counts for the legend only once the layout is
      // known to be current, so a superseded fetch cannot clobber fresh counts.
      useEdgeLegendStore.getState().setCounts(layout.edgeKindCounts);
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
        `renderFromLayout: graphEdges=${graph.edgeCount}, layoutEdges=${layout.edges.length}, layoutNodes=${Object.keys(layout.nodes).length}`
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

    // Draw edges. Recomputing the highlight here is what re-applies a pinned
    // selection after a layout/visibility rebuild.
    this.edgeManager.buildEdgeData(layout);
    this.rebuildHighlightedEdgeIndices(
      resolveHighlightSource(this.hoveredNodeId, this.selection)
    );
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
   * The rendered edge closest to a global (screen) pointer position, or null if
   * none is within the hit radius. Shared by edge hover and edge double-click so
   * both resolve to the same edge. The radius is in screen pixels, so it stays
   * constant as the user zooms.
   */
  private hitTestEdge(globalPos: { x: number; y: number }): EdgeDatum | null {
    const worldPos = this.viewport.toLocal(globalPos);
    let closestEdge: EdgeDatum | null = null;
    let closestDist = EDGE_HIT_RADIUS_PX / this.viewport.scale.x;
    for (const edge of this.edgeManager.edgeData) {
      if (edge.originalPoints.length < 2) continue;
      const dist = pointToPolylineDistance(worldPos, edge.originalPoints);
      if (dist < closestDist) {
        closestDist = dist;
        closestEdge = edge;
      }
    }
    return closestEdge;
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
    const display = createNodeDisplay(node, pos, this.nodeEmphasisFor(nodeId));

    // Click handler. Ctrl/Cmd-click toggles membership of the selection set
    // (multi-select); a plain click replaces it.
    display.container.on("pointerdown", (e) => {
      e.stopPropagation();
      useGraphStore.getState().selectNode(nodeId, e.ctrlKey || e.metaKey);

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
          selectionIds(this.selection),
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

    // Double-click behavior depends on the zoom-level view mode:
    //  - Module view: double-clicking a File drills into Symbol view focused on
    //    that file (instead of expanding code blocks in place). Other node types
    //    fall back to expand/collapse.
    //  - Symbol view: double-click expands/collapses as before.
    let lastClickTime = 0;
    display.container.on("pointertap", () => {
      const now = Date.now();
      if (now - lastClickTime < DOUBLE_TAP_MS) {
        const store = useGraphStore.getState();
        if (store.viewMode === "module" && node.type === "File") {
          store.enterFocus(nodeId);
        } else {
          store.toggleExpanded(nodeId);
        }
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
   * Uses the two-layer optimisation in EdgeDrawingManager: we only rebuild the
   * lightweight highlight layer instead of destroying and recreating all edge
   * graphics. Unhovering falls back to the pinned selection's highlight rather
   * than to full opacity (see `resolveHighlightSource`).
   */
  setHoveredNode(nodeId: string | null) {
    if (this.hoveredNodeId === nodeId) return;
    this.hoveredNodeId = nodeId;
    this.applyHighlight();
  }

  /**
   * Recompute which edges are highlighted from the current hover + selection,
   * then push the result onto the edge layers.
   */
  private applyHighlight() {
    const source = resolveHighlightSource(this.hoveredNodeId, this.selection);
    this.rebuildHighlightedEdgeIndices(source);

    // Try a highlight-only update (highlight layer only).
    // Falls back to a full redraw if the base layer doesn't exist yet.
    const handled = this.edgeManager.setHighlightActive(
      highlightDimsBaseLayer(source)
    );
    if (!handled) {
      this.triggerEdgeRedraw();
    }
  }

  /**
   * Fill `highlightedEdgeIndices` for a highlight source.
   *
   * `connected` lights every edge touching the node's subtree; `induced` lights
   * only edges whose BOTH endpoints fall inside the union of the selected
   * nodes' subtrees (so selecting two collapsed files shows exactly the traffic
   * between them).
   */
  private rebuildHighlightedEdgeIndices(source: HighlightSource) {
    const indices = this.edgeManager.highlightedEdgeIndices;
    indices.clear();

    if (source.mode === "none") {
      return;
    }

    if (source.mode === "connected") {
      for (const id of this.collectNodeSubtreeIds(source.nodeId)) {
        const edgeIndices = this.edgeManager.nodeToEdgeIndices.get(id);
        if (!edgeIndices) continue;

        for (const idx of edgeIndices) {
          indices.add(idx);
        }
      }
      return;
    }

    const members = new Set<string>();
    for (const nodeId of source.nodeIds) {
      for (const id of this.collectNodeSubtreeIds(nodeId)) {
        members.add(id);
      }
    }

    for (const id of members) {
      const edgeIndices = this.edgeManager.nodeToEdgeIndices.get(id);
      if (!edgeIndices) continue;

      for (const idx of edgeIndices) {
        const edge = this.edgeManager.edgeData[idx];
        if (edge && members.has(edge.source) && members.has(edge.target)) {
          indices.add(idx);
        }
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

  /**
   * Apply the store's selection: restyle the nodes whose selected-ness changed
   * and re-derive the pinned edge highlight.
   */
  setSelection(selectedNodeIds: ReadonlySet<string>, selectedNodeId: string | null) {
    const previous = selectionIds(this.selection);
    this.selection = selectionFromStore(selectedNodeIds, selectedNodeId);
    const current = selectionIds(this.selection);

    for (const id of previous) {
      if (current.has(id)) continue;
      this.restyleNode(id);
    }

    for (const id of current) {
      if (previous.has(id)) continue;
      this.restyleNode(id);
    }

    this.applyHighlight();
  }

  private isSelected(nodeId: string): boolean {
    return selectionIds(this.selection).has(nodeId);
  }

  /** A node's border emphasis from the current selection + hovered edge. */
  private nodeEmphasisFor(nodeId: string): NodeEmphasis {
    return resolveNodeEmphasis(
      this.isSelected(nodeId),
      this.hoveredEdgeEndpoints.has(nodeId)
    );
  }

  /** Redraw one node's background at its currently resolved emphasis. */
  private restyleNode(nodeId: string): void {
    const display = this.nodeDisplays.get(nodeId);
    if (display) redrawNodeBg(display, this.nodeEmphasisFor(nodeId));
  }

  /**
   * Emphasise the endpoints of the edge under the pointer, so it is obvious
   * where an edge actually lands in a dense view -- the tooltip only names them
   * in text. Pass nulls when no edge is hovered.
   *
   * Only the nodes whose endpoint-ness actually changed are redrawn, and each
   * is redrawn at its RESOLVED emphasis, so a selected endpoint keeps its
   * selected border throughout.
   */
  setHoveredEdgeEndpoints(source: string | null, target: string | null): void {
    const next = edgeEndpointIds(source, target);
    const changed = emphasisRedrawIds(this.hoveredEdgeEndpoints, next);
    if (changed.length === 0) return;

    this.hoveredEdgeEndpoints = next;
    for (const id of changed) {
      this.restyleNode(id);
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

    useGraphStore.getState().selectNode(nodeId);
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
        nodeType: d.nodeData.type,
        labelX: d.label.x,
        labelY: d.label.y,
        labelWidth: d.label.width,
        labelHeight: d.label.height,
        labelVisible: d.label.visible,
      };
    };

    this.edgeManager.redrawEdgesWithHighlight(
      this.edgeLayer,
      highlightDimsBaseLayer(
        resolveHighlightSource(this.hoveredNodeId, this.selection)
      ),
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
    if (this._edgeHoverRafId !== null) {
      cancelAnimationFrame(this._edgeHoverRafId);
      this._edgeHoverRafId = null;
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
