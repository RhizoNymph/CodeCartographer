import { useRef, useEffect, useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { PixiRenderer } from "./renderers/PixiRenderer";
import { useGraphStore } from "../stores/graphStore";
import { useViewportStore } from "../stores/viewportStore";
import { useDebugStore } from "../stores/debugStore";
import { useVisualizationStore } from "../stores/visualizationStore";
import {
  computeNodeMetrics,
  computeDependencyChain,
  normalizeMetrics,
} from "./utils/metricsUtils";

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
    layoutVersion,
  } = useGraphStore(
    useShallow((s) => ({
      graph: s.graph,
      expandedNodes: s.expandedNodes,
      visibleNodes: s.visibleNodes,
      selectedNodeId: s.selectedNodeId,
      hoveredNodeId: s.hoveredNodeId,
      enabledEdgeKinds: s.enabledEdgeKinds,
      layoutVersion: s.layoutVersion,
    }))
  );
  const mode = useVisualizationStore((s) => s.mode);
  const dependencyFlow = useVisualizationStore((s) => s.dependencyFlow);
  const hotspotMetric = useVisualizationStore((s) => s.hotspotMetric);
  const setDependencyFlow = useVisualizationStore((s) => s.setDependencyFlow);

  const [error, setError] = useState<string | null>(null);

  // --- Visualization mode effects ---

  // Overview mode: collapse to directory/file level
  const applyOverviewMode = useCallback(() => {
    if (!graph) return;
    const expanded = new Set<string>();
    const visible = new Set<string>();
    for (const [id, node] of Object.entries(graph.nodes)) {
      if (node.type !== "CodeBlock") {
        visible.add(id);
      }
      if (node.type === "Directory" && node.children.length > 0) {
        expanded.add(id);
      }
    }
    useGraphStore.setState({
      expandedNodes: expanded,
      visibleNodes: visible,
      layoutVersion: useGraphStore.getState().layoutVersion + 1,
    });
  }, [graph]);

  // Architecture mode: only root + direct directory children expanded
  const applyArchitectureMode = useCallback(() => {
    if (!graph) return;
    const rootNode = graph.nodes[graph.root];
    if (!rootNode) return;

    const expanded = new Set<string>();
    const visible = new Set<string>();

    // Root is expanded
    expanded.add(graph.root);
    visible.add(graph.root);

    // Direct children of root that are directories get expanded
    for (const childId of rootNode.children) {
      const child = graph.nodes[childId];
      if (!child) continue;
      visible.add(childId);
      if (child.type === "Directory") {
        expanded.add(childId);
        // Add their direct children as visible but not expanded
        for (const grandchildId of child.children) {
          const grandchild = graph.nodes[grandchildId];
          if (grandchild) {
            visible.add(grandchildId);
          }
        }
      }
    }

    useGraphStore.setState({
      expandedNodes: expanded,
      visibleNodes: visible,
      layoutVersion: useGraphStore.getState().layoutVersion + 1,
    });
  }, [graph]);

  // Default mode: restore full expansion
  const applyDefaultMode = useCallback(() => {
    if (!graph) return;
    const expanded = new Set<string>();
    const visible = new Set<string>();
    for (const [id, node] of Object.entries(graph.nodes)) {
      visible.add(id);
      if ((node.type === "Directory" || node.type === "File") && node.children.length > 0) {
        expanded.add(id);
      }
    }
    useGraphStore.setState({
      expandedNodes: expanded,
      visibleNodes: visible,
      layoutVersion: useGraphStore.getState().layoutVersion + 1,
    });
  }, [graph]);

  // When mode changes, apply the appropriate layout adjustments
  useEffect(() => {
    if (!graph) return;

    switch (mode) {
      case "overview":
        applyOverviewMode();
        break;
      case "architecture":
        applyArchitectureMode();
        break;
      case "default":
        applyDefaultMode();
        break;
      case "dependency":
      case "hotspot":
        // These modes don't change the layout, they just overlay visuals
        break;
    }
  }, [mode, graph, applyOverviewMode, applyArchitectureMode, applyDefaultMode]);

  // Track dependency direction separately to avoid infinite loop
  const dependencyDirection = dependencyFlow?.direction ?? "both";

  // Dependency flow: compute chain when dependency mode activates or direction changes
  useEffect(() => {
    if (mode !== "dependency" || !graph || !selectedNodeId) {
      return;
    }

    const chainNodes = computeDependencyChain(
      graph,
      selectedNodeId,
      dependencyDirection,
      enabledEdgeKinds
    );

    setDependencyFlow({
      nodeId: selectedNodeId,
      direction: dependencyDirection,
      chainNodes,
    });
  }, [mode, selectedNodeId, dependencyDirection, graph, enabledEdgeKinds, setDependencyFlow]);

  // Apply dependency highlighting to renderer
  useEffect(() => {
    if (!rendererRef.current) return;

    if (dependencyFlow && mode === "dependency") {
      rendererRef.current.setDependencyHighlight(dependencyFlow.chainNodes);
    } else {
      rendererRef.current.setDependencyHighlight(null);
    }
  }, [dependencyFlow, mode]);

  // Hotspot mode: compute and apply metrics coloring
  useEffect(() => {
    if (!rendererRef.current || !graph) return;

    if (mode === "hotspot") {
      const metrics = computeNodeMetrics(graph);
      const normalized = normalizeMetrics(metrics, hotspotMetric);
      rendererRef.current.setHotspotColors(normalized);
    } else {
      rendererRef.current.setHotspotColors(null);
    }
  }, [mode, hotspotMetric, graph]);

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
