import { useGraphStore } from "../stores/graphStore";
import {
  focusFrameKey,
  focusFrameLabel,
  truncateLabel,
  type FocusFrame,
} from "../stores/graphViewModel";
import type { FocusDirection } from "../api/types";

const barStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  maxWidth: "min(760px, calc(100% - 32px))",
  background: "#1e293b",
  border: "1px solid #3b82f6",
  borderRadius: 999,
  padding: "5px 8px 5px 12px",
  fontSize: 12,
  color: "#e2e8f0",
  zIndex: 120,
  display: "flex",
  gap: 6,
  alignItems: "center",
  boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
};

const crumbButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: "2px 4px",
  fontSize: 12,
  color: "#94a3b8",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const separatorStyle: React.CSSProperties = {
  color: "#475569",
  fontSize: 11,
};

const segmentedStyle: React.CSSProperties = {
  display: "flex",
  border: "1px solid #475569",
  borderRadius: 5,
  overflow: "hidden",
};

function segmentStyle(active: boolean): React.CSSProperties {
  return {
    padding: "2px 7px",
    fontSize: 11,
    border: "none",
    cursor: "pointer",
    background: active ? "#3b82f6" : "#334155",
    color: active ? "white" : "#cbd5e1",
    whiteSpace: "nowrap",
  };
}

/** Direction toggle labels, in caller -> callee reading order. */
const DIRECTIONS: ReadonlyArray<{
  value: FocusDirection;
  label: string;
  title: string;
}> = [
  { value: "upstream", label: "callers", title: "Trace callers only (upstream)" },
  { value: "both", label: "both", title: "Trace callers and callees" },
  { value: "downstream", label: "callees", title: "Trace callees only (downstream)" },
];

/**
 * Overlay breadcrumb trail shown while focus is active: a root "All" chip plus
 * one chip per focus stack frame. Clicking an earlier chip pops back to it;
 * the last (current) chip carries the hop-depth selector and direction toggle.
 * X clears the whole stack; Esc (useEscapeKey) pops one frame.
 */
export function FocusBreadcrumb() {
  const graph = useGraphStore((s) => s.graph);
  const focusStack = useGraphStore((s) => s.focusStack);
  const setFocusDepth = useGraphStore((s) => s.setFocusDepth);
  const setFocusDirection = useGraphStore((s) => s.setFocusDirection);
  const popToFrame = useGraphStore((s) => s.popToFrame);
  const exitFocus = useGraphStore((s) => s.exitFocus);

  if (focusStack.length === 0 || !graph) return null;

  const nameOf = (nodeId: string) => graph.nodes[nodeId]?.name ?? nodeId;
  const label = (frame: FocusFrame) =>
    truncateLabel(focusFrameLabel(frame, nameOf));

  const current = focusStack[focusStack.length - 1];

  return (
    <div style={barStyle}>
      <span style={{ color: "#60a5fa", fontWeight: 600 }}>Focus</span>

      <button
        onClick={() => exitFocus()}
        title="Back to the full graph"
        style={crumbButtonStyle}
      >
        All
      </button>

      {focusStack.map((frame, i) => {
        const isCurrent = i === focusStack.length - 1;
        const text = label(frame);
        return (
          <span
            key={`${focusFrameKey(frame)}@${i}`}
            style={{ display: "flex", gap: 6, alignItems: "center" }}
          >
            <span style={separatorStyle}>›</span>
            {isCurrent ? (
              <span
                style={{ fontWeight: 600, whiteSpace: "nowrap" }}
                title={focusFrameLabel(frame, nameOf)}
              >
                {text}
              </span>
            ) : (
              <button
                onClick={() => void popToFrame(i)}
                title={`Back to ${focusFrameLabel(frame, nameOf)}`}
                style={crumbButtonStyle}
              >
                {text}
              </button>
            )}
          </span>
        );
      })}

      {current.type === "node" && (
        <>
          <span role="group" aria-label="Focus depth" style={segmentedStyle}>
            {([1, 2] as const).map((d) => (
              <button
                key={d}
                onClick={() => void setFocusDepth(d)}
                title={`${d} hop${d > 1 ? "s" : ""}`}
                style={segmentStyle(current.depth === d)}
              >
                {d}
              </button>
            ))}
          </span>
          <span style={{ fontSize: 10, color: "#64748b" }}>hops</span>

          <span role="group" aria-label="Trace direction" style={segmentedStyle}>
            {DIRECTIONS.map((d) => (
              <button
                key={d.value}
                onClick={() => void setFocusDirection(d.value)}
                title={d.title}
                style={segmentStyle(current.direction === d.value)}
              >
                {d.label}
              </button>
            ))}
          </span>
        </>
      )}

      <button
        onClick={() => exitFocus()}
        title="Exit focus (Esc pops one level)"
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
