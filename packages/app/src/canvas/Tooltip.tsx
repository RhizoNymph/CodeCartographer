import { useGraphStore } from "../stores/graphStore";
import { useNodeDetails } from "../api/useNodeDetails";
import { BLOCK_COLORS, EDGE_COLORS, type EdgeKind } from "../api/types";

const tooltipStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: "50%",
  transform: "translateX(-50%)",
  background: "#1e293b",
  border: "1px solid #334155",
  borderRadius: 8,
  padding: "8px 14px",
  fontSize: 12,
  color: "#e2e8f0",
  pointerEvents: "none",
  zIndex: 100,
  maxWidth: 500,
  display: "flex",
  gap: 12,
  alignItems: "center",
  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
};

function edgeKindLabel(kind: EdgeKind): string {
  switch (kind) {
    case "FunctionCall": return "function calls";
    case "MethodCall": return "method calls";
    case "Import": return "imports";
    case "TypeReference": return "type references";
    case "Inheritance": return "inheritance links";
    case "TraitImpl": return "trait implementations";
    case "VariableUsage": return "variable usages";
  }
}

export function Tooltip() {
  const graph = useGraphStore((s) => s.graph);
  const hoveredNodeId = useGraphStore((s) => s.hoveredNodeId);
  const hoveredEdgeInfo = useGraphStore((s) => s.hoveredEdgeInfo);

  const hoveredNode =
    graph && hoveredNodeId ? graph.nodes[hoveredNodeId] : undefined;
  // Signatures are not in the bulk payload; fetch the hovered block's on demand.
  // Debounced, so a pointer sweeping across nodes issues no requests.
  const details = useNodeDetails(
    hoveredNode && hoveredNode.type === "CodeBlock" ? hoveredNode.id : null
  );
  const signature =
    hoveredNode && hoveredNode.type === "CodeBlock"
      ? (details && details.id === hoveredNode.id ? details.signature : null) ??
        hoveredNode.signature
      : null;

  // Edge tooltip (shown when hovering an edge and NOT hovering a node)
  if (!hoveredNodeId && hoveredEdgeInfo) {
    return (
      <div style={tooltipStyle}>
        <span style={{ color: EDGE_COLORS[hoveredEdgeInfo.kind], fontWeight: 600 }}>
          {hoveredEdgeInfo.count} {edgeKindLabel(hoveredEdgeInfo.kind)}
        </span>
        <span style={{ color: "#94a3b8" }}>
          from{" "}
          <span style={{ color: "#e2e8f0" }}>{hoveredEdgeInfo.sourceName}</span>
          {" "}to{" "}
          <span style={{ color: "#e2e8f0" }}>{hoveredEdgeInfo.targetName}</span>
        </span>
      </div>
    );
  }

  if (!graph || !hoveredNodeId) return null;

  const node = hoveredNode;
  if (!node) return null;

  return (
    <div style={tooltipStyle}>
      {node.type === "CodeBlock" && (
        <span
          style={{
            padding: "2px 6px",
            background: BLOCK_COLORS[node.kind] + "33",
            color: BLOCK_COLORS[node.kind],
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
          }}
        >
          {node.kind}
        </span>
      )}
      <span style={{ fontWeight: 600 }}>{node.name}</span>
      {node.type === "CodeBlock" && signature && (
        <span
          style={{
            color: "#64748b",
            fontFamily: "monospace",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {signature}
        </span>
      )}
      {node.type === "File" && (
        <span style={{ color: "#64748b" }}>
          {node.language || "unknown"} · {node.path}
        </span>
      )}
      {node.type === "Directory" && (
        <span style={{ color: "#64748b" }}>
          {node.children.length} items
        </span>
      )}
      {/*
        A hint, not a button: this tooltip unmounts on pointerout, so anything
        clickable here is unreachable -- the pointer has to leave the node to
        get to it. The reachable Focus affordances are the F hotkey and the
        selection chip.
      */}
      <span
        style={{
          marginLeft: 4,
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontSize: 10,
          color: "#93c5fd",
          whiteSpace: "nowrap",
        }}
      >
        <kbd
          style={{
            padding: "0 5px",
            border: "1px solid #3b5f8f",
            borderRadius: 3,
            fontFamily: "inherit",
            fontWeight: 600,
          }}
        >
          F
        </kbd>
        focus
      </span>
    </div>
  );
}
