import { useGraphStore } from "../stores/graphStore";
import { BLOCK_COLORS } from "../api/types";

const chipStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  background: "#1e293b",
  border: "1px solid #334155",
  borderRadius: 999,
  padding: "5px 8px 5px 14px",
  fontSize: 12,
  color: "#e2e8f0",
  zIndex: 110,
  display: "flex",
  gap: 10,
  alignItems: "center",
  maxWidth: "70%",
  boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
};

/**
 * Overlay chip for the currently selected canvas node, holding the Focus
 * action.
 *
 * Selection is sticky (a node's pointerdown sets it; empty-space pointerdown
 * clears it), unlike hover -- so unlike the tooltip's button, this one stays
 * put while the pointer travels to it. Hidden while focus mode is active,
 * where FocusBreadcrumb occupies the same slot.
 */
export function SelectionChip() {
  const graph = useGraphStore((s) => s.graph);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const focusStack = useGraphStore((s) => s.focusStack);
  const enterFocus = useGraphStore((s) => s.enterFocus);
  const setSelectedNode = useGraphStore((s) => s.setSelectedNode);

  if (!graph || !selectedNodeId || focusStack.length > 0) return null;

  const node = graph.nodes[selectedNodeId];
  if (!node) return null;

  return (
    <div style={chipStyle}>
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
      <span
        style={{
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {node.name}
      </span>

      <button
        onClick={() => enterFocus(selectedNodeId)}
        title="Focus on this node's neighborhood (F)"
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 9px",
          fontSize: 10,
          fontWeight: 600,
          border: "1px solid #3b82f6",
          borderRadius: 999,
          cursor: "pointer",
          background: "#1e3a5f",
          color: "#93c5fd",
        }}
      >
        Focus
        <kbd
          style={{
            padding: "0 4px",
            border: "1px solid #3b5f8f",
            borderRadius: 3,
            fontFamily: "inherit",
            fontSize: 9,
            color: "#7dabe0",
          }}
        >
          F
        </kbd>
      </button>

      <button
        onClick={() => setSelectedNode(null)}
        title="Clear selection"
        aria-label="Clear selection"
        style={{
          flexShrink: 0,
          padding: "1px 7px",
          fontSize: 13,
          lineHeight: 1,
          border: "none",
          borderRadius: 999,
          cursor: "pointer",
          background: "#334155",
          color: "#e2e8f0",
        }}
      >
        ×
      </button>
    </div>
  );
}
