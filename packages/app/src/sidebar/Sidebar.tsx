import { useGraphStore } from "../stores/graphStore";
import type { CodeNode } from "../api/types";
import { memo, useState, useMemo, useDeferredValue } from "react";
import { computeMatchingNodeIds } from "./searchUtils";

interface TreeItemProps {
  nodeId: string;
  depth: number;
  searchQuery: string;
  matchingNodeIds: Set<string>;
}

const TreeItem = memo(function TreeItem({ nodeId, depth, searchQuery, matchingNodeIds }: TreeItemProps) {
  const graph = useGraphStore((s) => s.graph);
  const expandedNodes = useGraphStore((s) => s.expandedNodes);
  const visibleNodes = useGraphStore((s) => s.visibleNodes);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const toggleExpanded = useGraphStore((s) => s.toggleExpanded);
  const toggleVisible = useGraphStore((s) => s.toggleVisible);
  const setSelectedNode = useGraphStore((s) => s.setSelectedNode);

  if (!graph) return null;
  const node = graph.nodes[nodeId];
  if (!node) return null;

  // Filter by search query — node must be in the pre-computed matching set
  if (!matchingNodeIds.has(nodeId)) return null;

  const isExpanded = expandedNodes.has(nodeId);
  const isVisible = visibleNodes.has(nodeId);
  const isSelected = selectedNodeId === nodeId;
  const hasChildren = node.children.length > 0;

  const icon = getIcon(node);
  const chevron = hasChildren ? (isExpanded ? "\u25be" : "\u25b8") : " ";

  return (
    <div>
      <div
        onClick={() => setSelectedNode(nodeId)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: depth * 16 + 4,
          paddingRight: 8,
          paddingTop: 2,
          paddingBottom: 2,
          cursor: "pointer",
          background: isSelected ? "#1e40af" : "transparent",
          borderRadius: 4,
          fontSize: 13,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = isSelected
            ? "#1e40af"
            : "#334155")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = isSelected
            ? "#1e40af"
            : "transparent")
        }
      >
        <input
          type="checkbox"
          checked={isVisible}
          onChange={(e) => {
            e.stopPropagation();
            toggleVisible(nodeId);
          }}
          style={{ cursor: "pointer", flexShrink: 0 }}
        />
        <span
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) toggleExpanded(nodeId);
          }}
          style={{
            cursor: hasChildren ? "pointer" : "default",
            userSelect: "none",
            flexShrink: 0,
            width: 12,
            textAlign: "center",
          }}
        >
          {chevron}
        </span>
        <span style={{ flexShrink: 0, width: 16, textAlign: "center" }}>
          {icon}
        </span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: getTextColor(node),
          }}
        >
          {highlightMatch(node.name, searchQuery)}
        </span>
        {node.type === "CodeBlock" && (
          <span
            style={{
              fontSize: 10,
              color: "#64748b",
              marginLeft: "auto",
              flexShrink: 0,
            }}
          >
            {node.kind.toLowerCase()}
          </span>
        )}
      </div>

      {isExpanded &&
        hasChildren &&
        node.children
          .filter((childId) => matchingNodeIds.has(childId))
          .map((childId) => (
            <TreeItem
              key={childId}
              nodeId={childId}
              depth={depth + 1}
              searchQuery={searchQuery}
              matchingNodeIds={matchingNodeIds}
            />
          ))}
    </div>
  );
}, (prev, next) =>
    prev.nodeId === next.nodeId &&
    prev.depth === next.depth &&
    prev.searchQuery === next.searchQuery &&
    prev.matchingNodeIds === next.matchingNodeIds
);

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;

  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;

  return (
    <>
      {text.slice(0, idx)}
      <span style={{ background: "#f59e0b33", color: "#fbbf24" }}>
        {text.slice(idx, idx + query.length)}
      </span>
      {text.slice(idx + query.length)}
    </>
  );
}

function getIcon(node: CodeNode): string {
  switch (node.type) {
    case "Directory":
      return "\ud83d\udcc1";
    case "File":
      return "\ud83d\udcc4";
    case "CodeBlock":
      switch (node.kind) {
        case "Function": return "\u0192";
        case "Class": return "C";
        case "Struct": return "S";
        case "Enum": return "E";
        case "Trait": return "T";
        case "Interface": return "I";
        case "Impl": return "\u21d2";
        case "Module": return "M";
        case "Constant": return "K";
        case "TypeAlias": return "\u2261";
        default: return "\u2022";
      }
  }
}

function getTextColor(node: CodeNode): string {
  switch (node.type) {
    case "Directory":
      return "#93c5fd";
    case "File":
      return "#e2e8f0";
    case "CodeBlock":
      return "#cbd5e1";
  }
}

export function Sidebar() {
  const graph = useGraphStore((s) => s.graph);
  const parseProgress = useGraphStore((s) => s.parseProgress);
  const isParsing = useGraphStore((s) => s.isParsing);
  const needsRelayout = useGraphStore((s) => s.needsRelayout);
  const requestRelayout = useGraphStore((s) => s.requestRelayout);
  const [searchInput, setSearchInput] = useState("");
  const searchQuery = useDeferredValue(searchInput);

  const matchingNodeIds = useMemo(
    () => graph ? computeMatchingNodeIds(graph, searchQuery) : new Set<string>(),
    [graph, searchQuery]
  );

  if (!graph) return null;

  const rootNode = graph.nodes[graph.root];
  if (!rootNode) return null;

  return (
    <div
      style={{
        width: 280,
        minWidth: 200,
        maxWidth: 400,
        height: "100%",
        background: "#1e293b",
        borderRight: "1px solid #334155",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Search and Relayout */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #334155" }}>
        <input
          type="text"
          placeholder="Search symbols..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{
            width: "100%",
            padding: "6px 10px",
            background: "#0f172a",
            border: "1px solid #334155",
            borderRadius: 6,
            color: "#e2e8f0",
            fontSize: 13,
            outline: "none",
          }}
          onFocus={(e) =>
            (e.currentTarget.style.borderColor = "#3b82f6")
          }
          onBlur={(e) =>
            (e.currentTarget.style.borderColor = "#334155")
          }
        />
        {needsRelayout && (
          <button
            onClick={requestRelayout}
            style={{
              marginTop: 8,
              width: "100%",
              padding: "6px 10px",
              background: "#3b82f6",
              border: "none",
              borderRadius: 6,
              color: "white",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 14 }}>&#8635;</span>
            Apply Layout Changes
          </button>
        )}
      </div>

      {/* Header */}
      <div
        style={{
          padding: "6px 12px",
          borderBottom: "1px solid #334155",
          fontSize: 11,
          fontWeight: 600,
          color: "#94a3b8",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Explorer
      </div>

      {/* Parse progress */}
      {isParsing && parseProgress && (
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #334155",
            fontSize: 11,
            color: "#94a3b8",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Parsing...</span>
            <span>
              {parseProgress.parsedFiles} files | {parseProgress.totalBlocks} blocks
            </span>
          </div>
          <div
            style={{
              marginTop: 4,
              height: 3,
              background: "#334155",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                background: "#3b82f6",
                width: `${Math.min(
                  100,
                  parseProgress.totalFiles > 0
                    ? (parseProgress.parsedFiles / parseProgress.totalFiles) * 100
                    : 0
                )}%`,
                transition: "width 0.2s",
              }}
            />
          </div>
          <div
            style={{
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 10,
              color: "#64748b",
            }}
          >
            {parseProgress.currentFile}
          </div>
        </div>
      )}

      {/* Tree */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "4px 0",
        }}
      >
        {rootNode.children
          .filter((childId) => matchingNodeIds.has(childId))
          .map((childId) => (
            <TreeItem
              key={childId}
              nodeId={childId}
              depth={0}
              searchQuery={searchQuery}
              matchingNodeIds={matchingNodeIds}
            />
          ))}
      </div>

      {/* Stats */}
      <div
        style={{
          padding: "8px 12px",
          borderTop: "1px solid #334155",
          fontSize: 11,
          color: "#64748b",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{Object.keys(graph.nodes).length} nodes</span>
        <span>{graph.edges.length} edges</span>
      </div>
    </div>
  );
}
