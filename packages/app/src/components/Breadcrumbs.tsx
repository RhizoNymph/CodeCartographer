import { useMemo } from "react";
import { useGraphStore } from "../stores/graphStore";
import { getNodeAncestorPath } from "../canvas/utils/graphUtils";
import { getIcon } from "../utils/nodeIcons";

export function Breadcrumbs() {
  const graph = useGraphStore((s) => s.graph);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const setSelectedNode = useGraphStore((s) => s.setSelectedNode);
  const requestZoomToNode = useGraphStore((s) => s.requestZoomToNode);

  const ancestorPath = useMemo(() => {
    if (!graph) return [];
    if (!selectedNodeId) {
      // Show root only
      const root = graph.nodes[graph.root];
      return root ? [graph.root] : [];
    }
    return getNodeAncestorPath(selectedNodeId, graph);
  }, [graph, selectedNodeId]);

  if (!graph) return null;

  const handleSegmentClick = (nodeId: string) => {
    setSelectedNode(nodeId);
    requestZoomToNode(nodeId);
  };

  return (
    <div
      style={{
        height: 28,
        background: "#1e293b",
        borderBottom: "1px solid #334155",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 0,
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {ancestorPath.map((nodeId, idx) => {
        const node = graph.nodes[nodeId];
        if (!node) return null;

        const isLast = idx === ancestorPath.length - 1;
        const icon = getIcon(node);

        return (
          <span key={nodeId} style={{ display: "flex", alignItems: "center" }}>
            {idx > 0 && (
              <span
                style={{
                  color: "#475569",
                  fontSize: 11,
                  margin: "0 6px",
                  userSelect: "none",
                }}
              >
                /
              </span>
            )}
            <button
              onClick={() => handleSegmentClick(nodeId)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 4px",
                borderRadius: 3,
                color: isLast ? "#e2e8f0" : "#94a3b8",
                fontWeight: isLast ? 600 : 400,
                fontSize: 12,
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "#334155")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <span style={{ fontSize: 11 }}>{icon}</span>
              <span>{node.name}</span>
            </button>
          </span>
        );
      })}
    </div>
  );
}
