import { useState, useMemo } from "react";
import { useGraphStore } from "../stores/graphStore";
import { getIcon } from "../utils/nodeIcons";
import type { CodeEdge, EdgeKind } from "../api/types";
import { EDGE_COLORS } from "../api/types";

export function DetailsPanel() {
  const graph = useGraphStore((s) => s.graph);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const detailsPanelOpen = useGraphStore((s) => s.detailsPanelOpen);
  const toggleDetailsPanel = useGraphStore((s) => s.toggleDetailsPanel);
  const setSelectedNode = useGraphStore((s) => s.setSelectedNode);
  const requestZoomToNode = useGraphStore((s) => s.requestZoomToNode);

  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(["path", "signature", "info", "incoming", "outgoing"])
  );

  const node = useMemo(() => {
    if (!graph || !selectedNodeId) return null;
    return graph.nodes[selectedNodeId] ?? null;
  }, [graph, selectedNodeId]);

  const { incoming, outgoing } = useMemo(() => {
    if (!graph || !selectedNodeId) return { incoming: [], outgoing: [] };
    const inc: CodeEdge[] = [];
    const out: CodeEdge[] = [];
    for (const edge of graph.edges) {
      if (edge.target === selectedNodeId) inc.push(edge);
      if (edge.source === selectedNodeId) out.push(edge);
    }
    return { incoming: inc, outgoing: out };
  }, [graph, selectedNodeId]);

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleNavigate = (nodeId: string) => {
    setSelectedNode(nodeId);
    requestZoomToNode(nodeId);
  };

  // Collapsed strip
  if (!detailsPanelOpen) {
    return (
      <div
        onClick={toggleDetailsPanel}
        style={{
          width: 24,
          height: "100%",
          background: "#1e293b",
          borderLeft: "1px solid #334155",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          flexShrink: 0,
        }}
        title="Open details panel"
      >
        <span
          style={{
            color: "#64748b",
            fontSize: 14,
            transform: "rotate(180deg)",
          }}
        >
          {"❯"}
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        width: 320,
        height: "100%",
        background: "#1e293b",
        borderLeft: "1px solid #334155",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid #334155",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
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
          Details
        </span>
        <button
          onClick={toggleDetailsPanel}
          style={{
            background: "none",
            border: "none",
            color: "#64748b",
            cursor: "pointer",
            fontSize: 14,
            padding: "2px 4px",
          }}
          title="Close details panel"
        >
          {"❯"}
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "8px 0" }}>
        {!node ? (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              color: "#64748b",
              fontSize: 13,
            }}
          >
            Select a node to view details
          </div>
        ) : (
          <>
            {/* Node name header */}
            <div
              style={{
                padding: "8px 16px 12px",
                borderBottom: "1px solid #334155",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 18 }}>{getIcon(node)}</span>
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: "#e2e8f0",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {node.name}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "#64748b",
                  marginTop: 4,
                }}
              >
                {node.type === "CodeBlock" ? node.kind : node.type}
              </div>
            </div>

            {/* Path section */}
            {(node.type === "File" || node.type === "Directory") && (
              <Section
                title="Path"
                id="path"
                expanded={expandedSections.has("path")}
                onToggle={toggleSection}
              >
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    fontSize: 12,
                    color: "#94a3b8",
                    wordBreak: "break-all",
                    lineHeight: 1.5,
                  }}
                >
                  {node.path}
                </div>
              </Section>
            )}

            {/* Signature section */}
            {node.type === "CodeBlock" && node.signature && (
              <Section
                title="Signature"
                id="signature"
                expanded={expandedSections.has("signature")}
                onToggle={toggleSection}
              >
                <pre
                  style={{
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    fontSize: 11,
                    color: "#e2e8f0",
                    background: "#0f172a",
                    padding: "8px 10px",
                    borderRadius: 6,
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    lineHeight: 1.5,
                  }}
                >
                  {node.signature}
                </pre>
              </Section>
            )}

            {/* Info section (visibility + span) */}
            {node.type === "CodeBlock" && (
              <Section
                title="Info"
                id="info"
                expanded={expandedSections.has("info")}
                onToggle={toggleSection}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {node.visibility && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: "#64748b" }}>
                        Visibility
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: visibilityColor(node.visibility),
                          color: "#e2e8f0",
                          fontWeight: 500,
                        }}
                      >
                        {node.visibility}
                      </span>
                    </div>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "#64748b" }}>
                      Lines
                    </span>
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                        fontSize: 11,
                        color: "#94a3b8",
                      }}
                    >
                      {node.span.start_line}:{node.span.start_col} &ndash;{" "}
                      {node.span.end_line}:{node.span.end_col}
                    </span>
                  </div>
                </div>
              </Section>
            )}

            {/* Incoming edges */}
            <Section
              title={`Incoming (${incoming.length})`}
              id="incoming"
              expanded={expandedSections.has("incoming")}
              onToggle={toggleSection}
            >
              {incoming.length === 0 ? (
                <div style={{ fontSize: 12, color: "#64748b" }}>None</div>
              ) : (
                <EdgeGroupList
                  edges={incoming}
                  graph={graph!}
                  nodeIdKey="source"
                  onNavigate={handleNavigate}
                />
              )}
            </Section>

            {/* Outgoing edges */}
            <Section
              title={`Outgoing (${outgoing.length})`}
              id="outgoing"
              expanded={expandedSections.has("outgoing")}
              onToggle={toggleSection}
            >
              {outgoing.length === 0 ? (
                <div style={{ fontSize: 12, color: "#64748b" }}>None</div>
              ) : (
                <EdgeGroupList
                  edges={outgoing}
                  graph={graph!}
                  nodeIdKey="target"
                  onNavigate={handleNavigate}
                />
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function visibilityColor(vis: string): string {
  switch (vis) {
    case "Public": return "#166534";
    case "Private": return "#7f1d1d";
    case "Protected": return "#713f12";
    case "Crate": return "#1e3a5f";
    default: return "#334155";
  }
}

interface SectionProps {
  title: string;
  id: string;
  expanded: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}

function Section({ title, id, expanded, onToggle, children }: SectionProps) {
  return (
    <div style={{ borderBottom: "1px solid #334155" }}>
      <div
        onClick={() => onToggle(id)}
        style={{
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          userSelect: "none",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "#334155")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = "transparent")
        }
      >
        <span
          style={{
            fontSize: 10,
            color: "#64748b",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
          }}
        >
          {"▶"}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#94a3b8",
            textTransform: "uppercase",
            letterSpacing: "0.03em",
          }}
        >
          {title}
        </span>
      </div>
      {expanded && <div style={{ padding: "0 16px 10px" }}>{children}</div>}
    </div>
  );
}

interface EdgeGroupListProps {
  edges: CodeEdge[];
  graph: { nodes: Record<string, { name: string }> };
  nodeIdKey: "source" | "target";
  onNavigate: (nodeId: string) => void;
}

function EdgeGroupList({ edges, graph, nodeIdKey, onNavigate }: EdgeGroupListProps) {
  // Group edges by kind
  const grouped = useMemo(() => {
    const groups = new Map<EdgeKind, CodeEdge[]>();
    for (const edge of edges) {
      const existing = groups.get(edge.kind) ?? [];
      existing.push(edge);
      groups.set(edge.kind, existing);
    }
    return groups;
  }, [edges]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from(grouped.entries()).map(([kind, kindEdges]) => (
        <div key={kind}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: EDGE_COLORS[kind],
              marginBottom: 4,
              display: "flex",
              alignItems: "center",
              gap: 6,
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
            {kind} ({kindEdges.length})
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              paddingLeft: 14,
            }}
          >
            {kindEdges.map((edge, i) => {
              const targetId = edge[nodeIdKey];
              const targetNode = graph.nodes[targetId];
              const name = targetNode?.name ?? targetId;
              return (
                <button
                  key={`${edge.source}-${edge.target}-${edge.kind}-${i}`}
                  onClick={() => onNavigate(targetId)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#60a5fa",
                    fontSize: 12,
                    cursor: "pointer",
                    textAlign: "left",
                    padding: "2px 4px",
                    borderRadius: 3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "#334155")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                  title={targetId}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
