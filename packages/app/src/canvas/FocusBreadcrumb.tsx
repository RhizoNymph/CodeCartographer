import { useEffect } from "react";
import { useGraphStore } from "../stores/graphStore";
import { focusBreadcrumbModel } from "../stores/graphViewModel";

const chipStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  background: "#1e293b",
  border: "1px solid #3b82f6",
  borderRadius: 999,
  padding: "5px 8px 5px 14px",
  fontSize: 12,
  color: "#e2e8f0",
  zIndex: 120,
  display: "flex",
  gap: 10,
  alignItems: "center",
  boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
};

/**
 * Overlay chip shown while a focus is active.
 *
 * A node focus displays the node's name plus a 1/2-hop depth selector. An edge
 * focus displays "source -> target" and NO depth selector: it shows exactly the
 * edges behind one aggregate, not a BFS radius, so hops are meaningless there.
 * Both offer an X to exit; Esc also exits.
 */
export function FocusBreadcrumb() {
  const graph = useGraphStore((s) => s.graph);
  const focusFrame = useGraphStore((s) => s.focusFrame);
  const focusDepth = useGraphStore((s) => s.focusDepth);
  const setFocusDepth = useGraphStore((s) => s.setFocusDepth);
  const exitFocus = useGraphStore((s) => s.exitFocus);

  // Esc exits focus.
  useEffect(() => {
    if (!focusFrame) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        exitFocus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusFrame, exitFocus]);

  const model = focusBreadcrumbModel(graph, focusFrame);
  if (!model) return null;

  return (
    <div style={chipStyle}>
      <span style={{ color: "#60a5fa", fontWeight: 600 }}>Focus</span>

      {model.type === "node" ? (
        <>
          <span style={{ fontWeight: 600 }}>{model.label}</span>

          <span
            role="group"
            aria-label="Focus depth"
            style={{
              display: "flex",
              border: "1px solid #475569",
              borderRadius: 5,
              overflow: "hidden",
            }}
          >
            {([1, 2] as const).map((d) => (
              <button
                key={d}
                onClick={() => setFocusDepth(d)}
                title={`${d} hop${d > 1 ? "s" : ""}`}
                style={{
                  padding: "2px 8px",
                  fontSize: 11,
                  border: "none",
                  cursor: "pointer",
                  background: focusDepth === d ? "#3b82f6" : "#334155",
                  color: focusDepth === d ? "white" : "#cbd5e1",
                }}
              >
                {d}
              </button>
            ))}
          </span>
          <span style={{ fontSize: 10, color: "#64748b" }}>hops</span>
        </>
      ) : (
        <span style={{ fontWeight: 600 }}>
          {model.sourceLabel}
          <span style={{ color: "#94a3b8", fontWeight: 400, margin: "0 6px" }}>→</span>
          {model.targetLabel}
        </span>
      )}

      <button
        onClick={exitFocus}
        title="Exit focus (Esc)"
        aria-label="Exit focus"
        style={{
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
