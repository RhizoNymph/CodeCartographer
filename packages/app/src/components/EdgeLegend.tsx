import { useState, useMemo } from "react";
import { useGraphStore } from "../stores/graphStore";
import type { EdgeKind } from "../api/types";
import { EDGE_COLORS } from "../api/types";

const ALL_EDGE_KINDS: EdgeKind[] = [
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
];

export function EdgeLegend() {
  const graph = useGraphStore((s) => s.graph);
  const enabledEdgeKinds = useGraphStore((s) => s.enabledEdgeKinds);
  const [collapsed, setCollapsed] = useState(false);

  const edgeCounts = useMemo(() => {
    if (!graph) return new Map<EdgeKind, number>();
    const counts = new Map<EdgeKind, number>();
    for (const edge of graph.edges) {
      counts.set(edge.kind, (counts.get(edge.kind) ?? 0) + 1);
    }
    return counts;
  }, [graph]);

  if (!graph) return null;

  if (collapsed) {
    return (
      <div
        onClick={() => setCollapsed(false)}
        style={{
          position: "absolute",
          bottom: 16,
          left: 16,
          zIndex: 50,
          background: "#1e293bdd",
          border: "1px solid #334155",
          borderRadius: 8,
          padding: "6px 10px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        title="Show edge legend"
      >
        <span style={{ fontSize: 12, color: "#94a3b8" }}>Edges</span>
        <span style={{ fontSize: 10, color: "#64748b" }}>{"▶"}</span>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        left: 16,
        zIndex: 50,
        background: "#1e293bdd",
        border: "1px solid #334155",
        borderRadius: 10,
        padding: "10px 14px",
        backdropFilter: "blur(8px)",
        minWidth: 160,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#94a3b8",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Edge Types
        </span>
        <button
          onClick={() => setCollapsed(true)}
          style={{
            background: "none",
            border: "none",
            color: "#64748b",
            cursor: "pointer",
            fontSize: 10,
            padding: "2px 4px",
          }}
          title="Collapse legend"
        >
          {"◀"}
        </button>
      </div>

      {/* Edge kind rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {ALL_EDGE_KINDS.map((kind) => {
          const count = edgeCounts.get(kind) ?? 0;
          const enabled = enabledEdgeKinds.has(kind);

          return (
            <div
              key={kind}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                opacity: enabled ? 1 : 0.35,
                transition: "opacity 0.15s",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: EDGE_COLORS[kind],
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: 12,
                  color: "#e2e8f0",
                  flex: 1,
                }}
              >
                {kind}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: "#64748b",
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  minWidth: 28,
                  textAlign: "right",
                }}
              >
                {count}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
