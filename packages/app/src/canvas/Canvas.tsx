import { useRef, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { PixiRenderer } from "./renderers/PixiRenderer";
import { useGraphStore } from "../stores/graphStore";
import { useViewportStore } from "../stores/viewportStore";
import { useDebugStore } from "../stores/debugStore";
import { computeDisplayVisibleNodes } from "../stores/visibilityFilter";
import {
  effectiveExpandedNodes,
  effectiveEdgeKinds,
  effectiveHideAmbiguous,
  focusVisibleNodes,
  focusExpandedNodes,
  focusIsActive,
} from "../stores/graphViewModel";

export function Canvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);
  const {
    graph,
    expandedNodes,
    visibleNodes,
    selectedNodeId,
    hoveredNodeId,
    enabledEdgeKinds,
    hideUnconnectedNodes,
    hideAmbiguousEdges,
    viewMode,
    focusStack,
    focusNeighborhood,
    layoutVersion,
  } = useGraphStore(
    useShallow((s) => ({
      graph: s.graph,
      expandedNodes: s.expandedNodes,
      visibleNodes: s.visibleNodes,
      selectedNodeId: s.selectedNodeId,
      hoveredNodeId: s.hoveredNodeId,
      enabledEdgeKinds: s.enabledEdgeKinds,
      hideUnconnectedNodes: s.hideUnconnectedNodes,
      hideAmbiguousEdges: s.hideAmbiguousEdges,
      viewMode: s.viewMode,
      focusStack: s.focusStack,
      focusNeighborhood: s.focusNeighborhood,
      layoutVersion: s.layoutVersion,
    }))
  );
  const [error, setError] = useState<string | null>(null);

  // Focused == some frame is on the stack AND its neighborhood has been fetched.
  const isFocused = focusIsActive(focusStack) && focusNeighborhood !== null;

  // Effective edge kinds fed to layout: module view forces {Import}; focus uses
  // the enabled kinds (already applied server-side to the neighborhood).
  const layoutEdgeKinds = useMemo(
    () => effectiveEdgeKinds(enabledEdgeKinds, viewMode),
    [enabledEdgeKinds, viewMode]
  );
  const layoutHideAmbiguous = useMemo(
    () => effectiveHideAmbiguous(hideAmbiguousEdges, viewMode),
    [hideAmbiguousEdges, viewMode]
  );

  // Effective expanded set. Focus expands the neighborhood's containers; module
  // view drops file expansion; symbol view uses the raw set.
  const layoutExpandedNodes = useMemo(() => {
    if (isFocused) {
      return focusExpandedNodes(graph, focusNeighborhood!.node_ids);
    }
    return effectiveExpandedNodes(graph, expandedNodes, viewMode);
  }, [isFocused, graph, focusNeighborhood, expandedNodes, viewMode]);

  // Visible set: focus restricts to the neighborhood ids; otherwise the normal
  // connectivity-filtered display set (using the effective edge kinds).
  const displayVisibleNodes = useMemo(() => {
    if (isFocused) {
      return focusVisibleNodes(graph, focusNeighborhood!.node_ids);
    }
    return computeDisplayVisibleNodes(
      graph,
      visibleNodes,
      layoutEdgeKinds,
      hideUnconnectedNodes
    );
  }, [isFocused, graph, focusNeighborhood, visibleNodes, layoutEdgeKinds, hideUnconnectedNodes]);

  useEffect(() => {
    if (!containerRef.current) return;

    let destroyed = false;
    const renderer = new PixiRenderer(containerRef.current);
    rendererRef.current = renderer;

    renderer.waitForInit().catch((err) => {
      if (!destroyed) {
        console.error("PixiRenderer init failed:", err);
        setError(String(err));
      }
    });

    return () => {
      destroyed = true;
      renderer.destroy();
    };
  }, []);

  // Only relayout when layoutVersion changes (triggered by setGraph or requestRelayout)
  useEffect(() => {
    const codeBlocks = graph ? Object.values(graph.nodes).filter(n => n.type === "CodeBlock").length : 0;
    const addLog = useDebugStore.getState().addLog;
    addLog(`Canvas: edges=${graph?.edgeCount ?? 0}, codeBlocks=${codeBlocks}, hasRenderer=${!!rendererRef.current}, layoutVersion=${layoutVersion}`);
    console.log("Canvas layout effect triggered:", {
      hasRenderer: !!rendererRef.current,
      hasGraph: !!graph,
      edges: graph?.edgeCount ?? 0,
      codeBlocks,
      layoutVersion,
    });
    if (rendererRef.current && graph) {
      rendererRef.current.updateGraph(
        graph,
        layoutExpandedNodes,
        displayVisibleNodes,
        layoutEdgeKinds,
        layoutHideAmbiguous
      );
    }
  }, [graph, layoutVersion, layoutEdgeKinds, layoutHideAmbiguous, layoutExpandedNodes, displayVisibleNodes]);

  // Update visibility immediately when nodes are checked/unchecked (without full relayout)
  useEffect(() => {
    if (rendererRef.current && graph) {
      rendererRef.current.updateVisibility(displayVisibleNodes);
    }
  }, [graph, displayVisibleNodes]);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setSelectedNode(selectedNodeId);
    }
  }, [selectedNodeId]);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setHoveredNode(hoveredNodeId);
    }
  }, [hoveredNodeId]);

  // Redraw edges when LOD settings change
  const edgeLODSettings = useViewportStore((s) => s.edgeLODSettings);
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.refreshEdges();
    }
  }, [edgeLODSettings]);

  if (error) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f172a",
          color: "#f87171",
          padding: 40,
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600 }}>Canvas failed to initialize</div>
        <pre
          style={{
            fontSize: 12,
            color: "#94a3b8",
            maxWidth: 600,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {error}
        </pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        position: "relative",
        overflow: "hidden",
        background: "#0f172a",
      }}
    />
  );
}
