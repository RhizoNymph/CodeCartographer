import { useRef, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { PixiRenderer } from "./renderers/PixiRenderer";
import { useGraphStore } from "../stores/graphStore";
import { useViewportStore } from "../stores/viewportStore";
import { useDebugStore } from "../stores/debugStore";
import { createGraphViewModel } from "./view/graphViewModel";

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
      layoutVersion: s.layoutVersion,
    }))
  );
  const searchMatchIds = useGraphStore((s) => s.searchMatchIds);
  const pendingZoomNodeId = useGraphStore((s) => s.pendingZoomNodeId);
  const [error, setError] = useState<string | null>(null);
  const graphView = useMemo(
    () => createGraphViewModel({
      graph,
      expandedNodes,
      visibleNodes,
      enabledEdgeKinds,
      hideUnconnectedNodes,
    }),
    [graph, expandedNodes, visibleNodes, enabledEdgeKinds, hideUnconnectedNodes]
  );

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
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(
        `Canvas: edges=${graph?.edges.length ?? 0}, codeBlocks=${codeBlocks}, hasRenderer=${!!rendererRef.current}, layoutVersion=${layoutVersion}`
      );
    }
    if (rendererRef.current && graphView.graph) {
      rendererRef.current.updateGraph(
        graphView.graph,
        graphView.expandedNodes,
        graphView.layoutVisibleNodes,
        graphView.enabledEdgeKinds
      );
    }
  }, [graph, layoutVersion, enabledEdgeKinds]);

  // Update visibility immediately when nodes are checked/unchecked (without full relayout)
  useEffect(() => {
    if (rendererRef.current && graph) {
      rendererRef.current.updateVisibility(graphView.layoutVisibleNodes);
    }
  }, [graph, graphView.layoutVisibleNodes]);

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

  // Search highlight
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setSearchHighlight(
        searchMatchIds.size > 0 ? searchMatchIds : null
      );
    }
  }, [searchMatchIds]);

  // Zoom to node (triggered from sidebar click or search navigation)
  useEffect(() => {
    if (rendererRef.current && pendingZoomNodeId) {
      rendererRef.current.zoomToNode(pendingZoomNodeId);
      useGraphStore.getState().requestZoomToNode(null);
    }
  }, [pendingZoomNodeId]);

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
