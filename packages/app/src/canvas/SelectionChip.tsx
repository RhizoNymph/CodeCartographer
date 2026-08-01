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

const nameStyle: React.CSSProperties = {
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const focusButtonStyle: React.CSSProperties = {
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  gap: 6,
  maxWidth: 220,
  padding: "2px 9px",
  fontSize: 10,
  fontWeight: 600,
  border: "1px solid #3b82f6",
  borderRadius: 999,
  cursor: "pointer",
  background: "#1e3a5f",
  color: "#93c5fd",
};

const clearButtonStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: "1px 7px",
  fontSize: 13,
  lineHeight: 1,
  border: "none",
  borderRadius: 999,
  cursor: "pointer",
  background: "#334155",
  color: "#e2e8f0",
};

/**
 * Overlay chip for the current canvas selection.
 *
 * One node selected: its kind badge + name, with the Focus action. Two or more:
 * an "N selected" summary (the canvas is showing the induced subgraph between
 * them) plus a Clear button. Focus always applies to the PRIMARY node only, so
 * in multi-select the button carries that node's name to stay unambiguous.
 *
 * Selection is sticky (a node's pointerdown sets it; empty-space pointerdown
 * clears it), unlike hover -- so unlike the tooltip's button, this one stays
 * put while the pointer travels to it. Hidden while focus mode is active,
 * where FocusBreadcrumb occupies the same slot.
 */
export function SelectionChip() {
  const graph = useGraphStore((s) => s.graph);
  const selectedNodeIds = useGraphStore((s) => s.selectedNodeIds);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const focusStack = useGraphStore((s) => s.focusStack);
  const enterFocus = useGraphStore((s) => s.enterFocus);
  const clearSelection = useGraphStore((s) => s.clearSelection);

  if (!graph || !selectedNodeId || focusStack.length > 0) return null;

  const primary = graph.nodes[selectedNodeId];
  if (!primary) return null;

  const count = selectedNodeIds.size;
  const isMulti = count > 1;

  return (
    <div style={chipStyle}>
      {isMulti ? (
        <span style={nameStyle}>{count} selected</span>
      ) : (
        <>
          {primary.type === "CodeBlock" && (
            <span
              style={{
                padding: "2px 6px",
                background: BLOCK_COLORS[primary.kind] + "33",
                color: BLOCK_COLORS[primary.kind],
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 600,
                textTransform: "uppercase",
              }}
            >
              {primary.kind}
            </span>
          )}
          <span style={nameStyle}>{primary.name}</span>
        </>
      )}

      <button
        onClick={() => enterFocus(selectedNodeId)}
        title={`Focus on ${primary.name}'s neighborhood (F)`}
        style={focusButtonStyle}
      >
        <span style={nameStyle}>{isMulti ? `Focus ${primary.name}` : "Focus"}</span>
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
        onClick={clearSelection}
        title="Clear selection (Esc)"
        aria-label="Clear selection"
        style={clearButtonStyle}
      >
        {isMulti ? "Clear" : "×"}
      </button>
    </div>
  );
}
