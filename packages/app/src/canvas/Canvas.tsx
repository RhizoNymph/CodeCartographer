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
  focusLayoutIds,
  focusTopFrame,
} from "../stores/graphViewModel";

export function Canvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);
  const {
    graph,
    expandedNodes,
    visibleNodes,
    selectedNodeIds,
    selectedNodeId,
    hoveredNodeId,
    hoveredEdgeInfo,
    enabledEdgeKinds,
    hideUnconnectedNodes,
    hideAmbiguousEdges,
    viewMode,
    focusStack,
    focusNeighborhood,
    focusEdgeDetail,
    layoutVersion,
    edgeVersion,
  } = useGraphStore(
    useShallow((s) => ({
      graph: s.graph,
      expandedNodes: s.expandedNodes,
      visibleNodes: s.visibleNodes,
      selectedNodeIds: s.selectedNodeIds,
      selectedNodeId: s.selectedNodeId,
      hoveredNodeId: s.hoveredNodeId,
      hoveredEdgeInfo: s.hoveredEdgeInfo,
      enabledEdgeKinds: s.enabledEdgeKinds,
      hideUnconnectedNodes: s.hideUnconnectedNodes,
      hideAmbiguousEdges: s.hideAmbiguousEdges,
      viewMode: s.viewMode,
      focusStack: s.focusStack,
      focusNeighborhood: s.focusNeighborhood,
      focusEdgeDetail: s.focusEdgeDetail,
      layoutVersion: s.layoutVersion,
      edgeVersion: s.edgeVersion,
    }))
  );
  const [error, setError] = useState<string | null>(null);

  // The ids to lay out while focused: the TOP frame's neighborhood (node frame)
  // or edge detail (edge frame). Null means "not focused" or "payload not here
  // yet" -- normal derivation applies.
  const focusIds = useMemo(
    () => focusLayoutIds(focusTopFrame(focusStack), focusNeighborhood, focusEdgeDetail),
    [focusStack, focusNeighborhood, focusEdgeDetail]
  );
  // Effective edge kinds fed to layout: module view forces {Import}; focus uses
  // the enabled kinds (already applied server-side to the fetched focus set).
  const layoutEdgeKinds = useMemo(
    () => effectiveEdgeKinds(enabledEdgeKinds, viewMode),
    [enabledEdgeKinds, viewMode]
  );
  const layoutHideAmbiguous = useMemo(
    () => effectiveHideAmbiguous(hideAmbiguousEdges, viewMode),
    [hideAmbiguousEdges, viewMode]
  );

  // Effective expanded set. Focus expands the focus set's containers; module
  // view drops file expansion; symbol view uses the raw set.
  const layoutExpandedNodes = useMemo(() => {
    if (focusIds) {
      return focusExpandedNodes(graph, focusIds);
    }
    return effectiveExpandedNodes(graph, expandedNodes, viewMode);
  }, [focusIds, graph, expandedNodes, viewMode]);

  // Visible set: focus restricts to the focus ids; otherwise the normal
  // connectivity-filtered display set (using the effective edge kinds).
  const displayVisibleNodes = useMemo(() => {
    if (focusIds) {
      return focusVisibleNodes(graph, focusIds);
    }
    return computeDisplayVisibleNodes(
      graph,
      visibleNodes,
      layoutEdgeKinds,
      hideUnconnectedNodes
    );
  }, [focusIds, graph, visibleNodes, layoutEdgeKinds, hideUnconnectedNodes]);

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

  // The latest derived layout inputs. The layout effects deliberately do NOT
  // depend on these: every store write produces fresh Set identities, so
  // depending on them would run a full ELK layout for changes that cannot move a
  // node. The store's trigger versions decide what runs (stores/relayoutPolicy);
  // the effects then read whatever the newest inputs are.
  const layoutInputsRef = useRef({
    graph,
    layoutExpandedNodes,
    displayVisibleNodes,
    layoutEdgeKinds,
    layoutHideAmbiguous,
  });
  layoutInputsRef.current = {
    graph,
    layoutExpandedNodes,
    displayVisibleNodes,
    layoutEdgeKinds,
    layoutHideAmbiguous,
  };

  // The visible set already handed to the renderer, so the cheap visibility
  // effect below does not repeat work a layout request has just covered.
  const appliedVisibleRef = useRef<Set<string> | null>(null);

  // POSITIONS phase: a full ELK layout, only when layoutVersion says the node
  // set or containment tree changed (fresh graph, expand/collapse, view mode,
  // focus, hide-unconnected, or the explicit Apply Layout Changes button).
  useEffect(() => {
    const renderer = rendererRef.current;
    const inputs = layoutInputsRef.current;

    if (import.meta.env.DEV) {
      const codeBlocks = inputs.graph
        ? Object.values(inputs.graph.nodes).filter((n) => n.type === "CodeBlock").length
        : 0;
      useDebugStore
        .getState()
        .addLog(
          `Canvas: edges=${inputs.graph?.edgeCount ?? 0}, codeBlocks=${codeBlocks}, hasRenderer=${!!renderer}, layoutVersion=${layoutVersion}`
        );
    }

    if (renderer && inputs.graph) {
      appliedVisibleRef.current = inputs.displayVisibleNodes;
      renderer.updateGraph(
        inputs.graph,
        inputs.layoutExpandedNodes,
        inputs.displayVisibleNodes,
        inputs.layoutEdgeKinds,
        inputs.layoutHideAmbiguous
      );
    }
  }, [graph, layoutVersion]);

  // EDGES phase: which edges show changed (edge-kind toggle, hide-ambiguous).
  // Re-fetches and redraws against the cached node positions -- no ELK run.
  useEffect(() => {
    if (edgeVersion === 0) return;
    const renderer = rendererRef.current;
    const inputs = layoutInputsRef.current;
    if (renderer && inputs.graph) {
      renderer.updateEdges(inputs.layoutEdgeKinds, inputs.layoutHideAmbiguous);
    }
  }, [edgeVersion]);

  // Cheapest path: nodes were hidden (sidebar checkbox), so flip the existing
  // displays instead of laying anything out.
  useEffect(() => {
    if (rendererRef.current && graph) {
      if (appliedVisibleRef.current === displayVisibleNodes) return;
      appliedVisibleRef.current = displayVisibleNodes;
      rendererRef.current.updateVisibility(displayVisibleNodes);
    }
  }, [graph, displayVisibleNodes]);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setSelection(selectedNodeIds, selectedNodeId);
    }
  }, [selectedNodeIds, selectedNodeId]);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setHoveredNode(hoveredNodeId);
    }
  }, [hoveredNodeId]);

  // Emphasise the hovered edge's endpoint nodes, so it is visible where the
  // edge lands without tracing the polyline by eye.
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setHoveredEdgeEndpoints(
        hoveredEdgeInfo?.sourceId ?? null,
        hoveredEdgeInfo?.targetId ?? null
      );
    }
  }, [hoveredEdgeInfo]);

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
