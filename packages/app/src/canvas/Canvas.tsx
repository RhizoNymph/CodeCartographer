import { useRef, useEffect, useState } from "react";
import { PixiRenderer } from "./renderers/PixiRenderer";
import { useGraphStore } from "../stores/graphStore";
import { useViewportStore } from "../stores/viewportStore";
import { useDebugStore } from "../stores/debugStore";

export function Canvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);
  const graph = useGraphStore((s) => s.graph);
  const expandedNodes = useGraphStore((s) => s.expandedNodes);
  const visibleNodes = useGraphStore((s) => s.visibleNodes);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const hoveredNodeId = useGraphStore((s) => s.hoveredNodeId);
  const enabledEdgeKinds = useGraphStore((s) => s.enabledEdgeKinds);
  const layoutVersion = useGraphStore((s) => s.layoutVersion);
  const [error, setError] = useState<string | null>(null);

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
    addLog(`Canvas: edges=${graph?.edges.length ?? 0}, codeBlocks=${codeBlocks}, hasRenderer=${!!rendererRef.current}, layoutVersion=${layoutVersion}`);
    console.log("Canvas layout effect triggered:", {
      hasRenderer: !!rendererRef.current,
      hasGraph: !!graph,
      edges: graph?.edges.length ?? 0,
      codeBlocks,
      layoutVersion,
    });
    if (rendererRef.current && graph) {
      rendererRef.current.updateGraph(graph, expandedNodes, visibleNodes, enabledEdgeKinds);
    }
  }, [graph, layoutVersion, enabledEdgeKinds]);

  // Update visibility immediately when nodes are checked/unchecked (without full relayout)
  useEffect(() => {
    if (rendererRef.current && graph) {
      rendererRef.current.updateVisibility(visibleNodes);
    }
  }, [graph, visibleNodes]);

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
