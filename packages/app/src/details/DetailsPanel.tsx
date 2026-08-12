import { useEffect, useMemo, useRef, useState } from "react";
import { getNeighborhood } from "../api/commands";
import { useNodeDetails } from "../api/useNodeDetails";
import { BLOCK_COLORS, EDGE_COLORS, type Neighborhood } from "../api/types";
import { edgeKindLabel } from "../canvas/legend/edgeLegendModel";
import { useGraphStore } from "../stores/graphStore";
import {
  DETAILS_EDGE_KINDS,
  buildDetailsEdgeModel,
  buildNodeSummary,
  type DirectionSection,
  type EdgeKindGroup,
  type EndpointRow,
  type NodeSummary,
} from "./detailsPanelModel";

/** Depth-1 neighborhood: exactly the selected node's direct callers + callees. */
const DETAIL_DEPTH = 1;

/**
 * Selection can move faster than the IPC round-trip (arrow-keying the sidebar,
 * clicking through endpoint rows), so wait for it to settle before fetching.
 */
const FETCH_DEBOUNCE_MS = 120;

const PANEL_WIDTH = 300;

interface FetchError {
  message: string;
}

/**
 * Right-side panel describing the selected node: what it is, and every edge
 * touching it, grouped by kind and direction.
 *
 * This is the long-term home for drill-in actions. The hover tooltip cannot hold
 * buttons -- it unmounts on pointerout, before the pointer can reach them --
 * whereas selection is sticky, so everything clickable about a node belongs
 * here.
 *
 * Renders nothing unless a node is selected; collapses to a thin reopen tab.
 */
export function DetailsPanel() {
  // The panel's ENTIRE selection read surface: one selector. When selection
  // becomes a multi-select set with a derived primary, only this line changes.
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);

  const graph = useGraphStore((s) => s.graph);
  const enterFocus = useGraphStore((s) => s.enterFocus);
  const selectNode = useGraphStore((s) => s.selectNode);
  const clearSelection = useGraphStore((s) => s.clearSelection);

  const [collapsed, setCollapsed] = useState(false);
  const [neighborhood, setNeighborhood] = useState<Neighborhood | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FetchError | null>(null);

  // Monotonic request token: a response is applied only if it is still the one
  // the panel is waiting for (same guard as the renderer's layout requests).
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setNeighborhood(null);
    setError(null);

    if (!selectedNodeId || !graph) {
      setPending(false);
      return;
    }

    setPending(true);
    const timer = setTimeout(() => {
      getNeighborhood(selectedNodeId, DETAIL_DEPTH, [...DETAILS_EDGE_KINDS], "both")
        .then((result) => {
          if (requestId !== requestIdRef.current) return; // stale -- discard
          setNeighborhood(result);
          setPending(false);
        })
        .catch((err: unknown) => {
          if (requestId !== requestIdRef.current) return; // stale -- discard
          setError({ message: err instanceof Error ? err.message : String(err) });
          setPending(false);
        });
    }, FETCH_DEBOUNCE_MS);

    return () => {
      // Supersede the in-flight request so its response is dropped.
      requestIdRef.current += 1;
      clearTimeout(timer);
    };
  }, [selectedNodeId, graph]);

  const node = selectedNodeId && graph ? graph.nodes[selectedNodeId] : undefined;

  // The bulk payload carries no signatures: fetch the selected node's on demand
  // (debounced + stale-guarded, like the neighborhood fetch above).
  const details = useNodeDetails(selectedNodeId);

  const summary = useMemo<NodeSummary | null>(
    () => (node ? buildNodeSummary(node, details) : null),
    [node, details]
  );

  const edges = useMemo(
    () =>
      selectedNodeId && graph
        ? buildDetailsEdgeModel(selectedNodeId, neighborhood, graph.nodes)
        : null,
    [selectedNodeId, graph, neighborhood]
  );

  if (!selectedNodeId || !summary || !edges) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title="Show details"
        style={{
          flexShrink: 0,
          width: 22,
          height: "100%",
          background: "#1e293b",
          borderLeft: "1px solid #334155",
          borderTop: "none",
          borderRight: "none",
          borderBottom: "none",
          color: "#94a3b8",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          writingMode: "vertical-rl",
          cursor: "pointer",
          padding: "10px 0",
        }}
      >
        Details
      </button>
    );
  }

  return (
    <div
      style={{
        width: PANEL_WIDTH,
        flexShrink: 0,
        height: "100%",
        background: "#1e293b",
        borderLeft: "1px solid #334155",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontSize: 12,
        color: "#e2e8f0",
      }}
      aria-label="Node details"
    >
      <Header
        summary={summary}
        onCollapse={() => setCollapsed(true)}
        onClear={() => clearSelection()}
      />

      <div style={{ overflowY: "auto", padding: "10px 12px 16px" }}>
        <button
          type="button"
          onClick={() => enterFocus(summary.id)}
          title="Focus on this node's neighborhood (F)"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            width: "100%",
            padding: "6px 10px",
            marginBottom: 12,
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid #3b82f6",
            borderRadius: 6,
            cursor: "pointer",
            background: "#1e3a5f",
            color: "#93c5fd",
          }}
        >
          Focus this node
          <kbd
            style={{
              padding: "0 4px",
              border: "1px solid #3b5f8f",
              borderRadius: 3,
              fontFamily: "inherit",
              fontSize: 10,
            }}
          >
            F
          </kbd>
        </button>

        <FactList summary={summary} />

        {error && (
          <div
            role="alert"
            style={{
              margin: "12px 0 0",
              padding: "6px 8px",
              borderRadius: 6,
              background: "#7f1d1d33",
              border: "1px solid #7f1d1d",
              color: "#fca5a5",
              fontSize: 11,
            }}
          >
            Could not load edges: {error.message}
          </div>
        )}

        {!error && (
          <>
            <EdgeSection
              section={edges.incoming}
              title="Incoming"
              subtitle="callers / referrers"
              pending={pending}
              onSelect={(id) => selectNode(id)}
              onFocus={enterFocus}
            />
            <EdgeSection
              section={edges.outgoing}
              title="Outgoing"
              subtitle="callees / references"
              pending={pending}
              onSelect={(id) => selectNode(id)}
              onFocus={enterFocus}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ header

function Header({
  summary,
  onCollapse,
  onClear,
}: {
  summary: NodeSummary;
  onCollapse: () => void;
  onClear: () => void;
}) {
  const badgeColor = summary.blockKind
    ? BLOCK_COLORS[summary.blockKind]
    : "#94a3b8";

  return (
    <div
      style={{
        padding: "8px 8px 8px 12px",
        borderBottom: "1px solid #334155",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            padding: "2px 6px",
            background: badgeColor + "33",
            color: badgeColor,
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            flexShrink: 0,
          }}
        >
          {summary.badge}
        </span>
        <span style={{ flex: 1 }} />
        <IconButton label="Clear selection" onClick={onClear}>
          ×
        </IconButton>
        <IconButton label="Hide details" onClick={onCollapse}>
          ›
        </IconButton>
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          wordBreak: "break-word",
        }}
        title={summary.name}
      >
        {summary.name}
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        flexShrink: 0,
        width: 20,
        height: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        lineHeight: 1,
        border: "none",
        borderRadius: 4,
        cursor: "pointer",
        background: "#334155",
        color: "#e2e8f0",
      }}
    >
      {children}
    </button>
  );
}

function FactList({ summary }: { summary: NodeSummary }) {
  return (
    <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: 5 }}>
      {summary.facts.map((fact) => (
        <div key={fact.label} style={{ display: "flex", gap: 8 }}>
          <dt
            style={{
              width: 66,
              flexShrink: 0,
              color: "#64748b",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              paddingTop: 1,
            }}
          >
            {fact.label}
          </dt>
          <dd
            style={{
              margin: 0,
              flex: 1,
              minWidth: 0,
              color: "#cbd5e1",
              fontSize: 11,
              fontFamily: fact.mono ? "monospace" : "inherit",
              wordBreak: "break-word",
            }}
            title={fact.value}
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ------------------------------------------------------------ edge sections

function EdgeSection({
  section,
  title,
  subtitle,
  pending,
  onSelect,
  onFocus,
}: {
  section: DirectionSection;
  title: string;
  subtitle: string;
  pending: boolean;
  onSelect: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
}) {
  return (
    <section style={{ marginTop: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          paddingBottom: 6,
          borderBottom: "1px solid #334155",
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: "#94a3b8",
          }}
        >
          {title}
        </span>
        <span style={{ fontSize: 10, color: "#475569" }}>{subtitle}</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 11,
            color: "#64748b",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {pending ? "…" : section.total}
        </span>
      </div>

      {pending ? (
        <EmptyNote>Loading…</EmptyNote>
      ) : section.groups.length === 0 ? (
        <EmptyNote>No {title.toLowerCase()} edges</EmptyNote>
      ) : (
        section.groups.map((group) => (
          <KindGroup
            key={group.kind}
            group={group}
            onSelect={onSelect}
            onFocus={onFocus}
          />
        ))
      )}
    </section>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "8px 2px", color: "#475569", fontSize: 11 }}>
      {children}
    </div>
  );
}

function KindGroup({
  group,
  onSelect,
  onFocus,
}: {
  group: EdgeKindGroup;
  onSelect: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "0 2px 3px",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 14,
            height: 3,
            flexShrink: 0,
            borderRadius: 2,
            background: EDGE_COLORS[group.kind],
          }}
        />
        <span style={{ fontSize: 11, color: "#cbd5e1" }}>
          {edgeKindLabel(group.kind)}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 11,
            color: "#64748b",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {group.count}
        </span>
      </div>
      {group.endpoints.map((endpoint) => (
        <EndpointItem
          key={endpoint.nodeId}
          endpoint={endpoint}
          onSelect={onSelect}
          onFocus={onFocus}
        />
      ))}
    </div>
  );
}

function EndpointItem({
  endpoint,
  onSelect,
  onFocus,
}: {
  endpoint: EndpointRow;
  onSelect: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
}) {
  const nameColor = endpoint.blockKind
    ? BLOCK_COLORS[endpoint.blockKind]
    : "#e2e8f0";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 21,
      }}
    >
      <button
        type="button"
        onClick={() => onSelect(endpoint.nodeId)}
        title={endpoint.detail ?? endpoint.name}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 4px",
          background: "transparent",
          border: "none",
          borderRadius: 4,
          color: "inherit",
          font: "inherit",
          fontSize: 11,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: nameColor,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {endpoint.name}
          {endpoint.selfLoop && (
            <span style={{ color: "#64748b" }}> (self)</span>
          )}
        </span>
        {endpoint.count > 1 && (
          <span
            style={{
              flexShrink: 0,
              color: "#64748b",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            ×{endpoint.count}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => onFocus(endpoint.nodeId)}
        title={`Focus on ${endpoint.name}'s neighborhood`}
        style={{
          flexShrink: 0,
          padding: "1px 6px",
          fontSize: 9,
          fontWeight: 600,
          border: "1px solid #3b82f6",
          borderRadius: 4,
          cursor: "pointer",
          background: "#1e3a5f",
          color: "#93c5fd",
        }}
      >
        Focus
      </button>
    </div>
  );
}
