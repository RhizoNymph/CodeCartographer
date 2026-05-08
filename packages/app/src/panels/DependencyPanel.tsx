import { useVisualizationStore } from "../stores/visualizationStore";
import { useGraphStore } from "../stores/graphStore";

export function DependencyPanel() {
  const dependencyFlow = useVisualizationStore((s) => s.dependencyFlow);
  const setDependencyFlow = useVisualizationStore((s) => s.setDependencyFlow);
  const setMode = useVisualizationStore((s) => s.setMode);
  const graph = useGraphStore((s) => s.graph);

  if (!dependencyFlow) return null;

  const node = graph?.nodes[dependencyFlow.nodeId];
  const nodeName = node?.name ?? dependencyFlow.nodeId;
  const chainSize = dependencyFlow.chainNodes.size;

  // Compute depth: how many BFS levels from start node
  // (rough estimate based on chain size)
  const depthEstimate = Math.ceil(Math.log2(Math.max(chainSize, 2)));

  const directionLabels: Record<string, string> = {
    upstream: "upstream of",
    downstream: "downstream of",
    both: "connected to",
  };

  const handleDirectionChange = (direction: "upstream" | "downstream" | "both") => {
    // The actual recomputation is triggered via Canvas.tsx effect
    // when the dependency flow state changes
    setDependencyFlow({
      ...dependencyFlow,
      direction,
      // chainNodes will be recomputed by the Canvas effect
      chainNodes: dependencyFlow.chainNodes,
    });
  };

  const handleClear = () => {
    setDependencyFlow(null);
    setMode("default");
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: "50%",
        transform: "translateX(-50%)",
        background: "#1e293b",
        border: "1px solid #334155",
        borderRadius: 8,
        padding: "8px 14px",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: 10,
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        fontSize: 12,
        color: "#e2e8f0",
      }}
    >
      {/* Info */}
      <div>
        <span style={{ color: "#64748b" }}>Tracing </span>
        <span style={{ color: "#60a5fa", fontWeight: 500 }}>
          {directionLabels[dependencyFlow.direction]}
        </span>
        <span style={{ color: "#64748b" }}> </span>
        <span style={{ color: "#f1f5f9", fontWeight: 600 }}>{nodeName}</span>
      </div>

      {/* Chain summary */}
      <div
        style={{
          fontSize: 10,
          color: "#94a3b8",
          borderLeft: "1px solid #334155",
          paddingLeft: 10,
        }}
      >
        {chainSize} nodes, ~{depthEstimate} levels
      </div>

      {/* Direction buttons */}
      <div style={{ display: "flex", gap: 2 }}>
        {(["upstream", "downstream", "both"] as const).map((dir) => (
          <button
            key={dir}
            onClick={() => handleDirectionChange(dir)}
            style={{
              padding: "2px 8px",
              fontSize: 10,
              fontWeight: 500,
              border: "1px solid #475569",
              borderRadius: 4,
              cursor: "pointer",
              background:
                dependencyFlow.direction === dir ? "#3b82f6" : "#334155",
              color:
                dependencyFlow.direction === dir ? "#ffffff" : "#94a3b8",
            }}
          >
            {dir === "upstream" ? "Up" : dir === "downstream" ? "Down" : "Both"}
          </button>
        ))}
      </div>

      {/* Clear button */}
      <button
        onClick={handleClear}
        style={{
          padding: "2px 8px",
          fontSize: 10,
          fontWeight: 500,
          border: "1px solid #475569",
          borderRadius: 4,
          cursor: "pointer",
          background: "#334155",
          color: "#f87171",
        }}
      >
        Clear
      </button>
    </div>
  );
}
