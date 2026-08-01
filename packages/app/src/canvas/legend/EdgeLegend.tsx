import { memo, useMemo } from "react";
import { EDGE_COLORS } from "../../api/types";
import { useGraphStore } from "../../stores/graphStore";
import { useEdgeLegendStore } from "../../stores/edgeLegendStore";
import { buildLegendRows, type LegendRow } from "./edgeLegendModel";

const panelStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: 16,
  background: "#1e293b",
  border: "1px solid #334155",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 11,
  color: "#e2e8f0",
  zIndex: 110,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
  userSelect: "none",
};

const headerStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "#64748b",
  padding: "0 4px 4px",
};

/**
 * Bottom-left canvas overlay listing every edge kind available in the current
 * view with its colour, name, and the number of underlying edges of that kind in
 * the view. It is also the edge-kind toggle UI: clicking an interactive row
 * flips that kind in `graphStore.enabledEdgeKinds`.
 *
 * Sizes to its content so it never blocks canvas interaction outside its own box.
 */
export const EdgeLegend = memo(function EdgeLegend() {
  const graph = useGraphStore((s) => s.graph);
  const viewMode = useGraphStore((s) => s.viewMode);
  const enabledEdgeKinds = useGraphStore((s) => s.enabledEdgeKinds);
  const toggleEdgeKind = useGraphStore((s) => s.toggleEdgeKind);
  const counts = useEdgeLegendStore((s) => s.counts);

  const rows = useMemo(
    () => buildLegendRows({ counts, enabledEdgeKinds, viewMode }),
    [counts, enabledEdgeKinds, viewMode]
  );

  if (!graph || graph.edgeCount === 0) return null;

  return (
    <div style={panelStyle} role="group" aria-label="Edge kinds">
      <div style={headerStyle}>
        {viewMode === "module" ? "Edges (module view)" : "Edges"}
      </div>
      {rows.map((row) => (
        <LegendRowItem key={row.kind} row={row} onToggle={toggleEdgeKind} />
      ))}
    </div>
  );
});

interface RowProps {
  row: LegendRow;
  onToggle: (kind: LegendRow["kind"]) => void;
}

function LegendRowItem({ row, onToggle }: RowProps) {
  const title = row.interactive
    ? `${row.enabled ? "Hide" : "Show"} ${row.label.toLowerCase()}`
    : row.count === 0
      ? `No ${row.label.toLowerCase()} in this view`
      : "Module view shows imports only";

  return (
    <button
      type="button"
      onClick={row.interactive ? () => onToggle(row.kind) : undefined}
      disabled={!row.interactive}
      aria-pressed={row.enabled}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        padding: "3px 4px",
        background: "transparent",
        border: "none",
        borderRadius: 4,
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        cursor: row.interactive ? "pointer" : "default",
        opacity: row.dimmed ? 0.42 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          height: 3,
          flexShrink: 0,
          borderRadius: 2,
          background: EDGE_COLORS[row.kind],
        }}
      />
      <span
        style={{
          flex: 1,
          whiteSpace: "nowrap",
          textDecoration: row.struck ? "line-through" : "none",
        }}
      >
        {row.label}
      </span>
      <span
        style={{
          color: "#64748b",
          fontVariantNumeric: "tabular-nums",
          minWidth: 28,
          textAlign: "right",
        }}
      >
        {row.count === null ? "—" : row.count.toLocaleString()}
      </span>
    </button>
  );
}
