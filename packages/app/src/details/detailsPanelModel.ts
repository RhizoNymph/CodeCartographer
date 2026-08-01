import type {
  BlockKind,
  CodeNode,
  EdgeKind,
  Neighborhood,
  Span,
} from "../api/types";

/**
 * Pure view model for the details panel.
 *
 * This module deliberately has TYPE-ONLY imports: it is unit-tested directly
 * under `node --test`, whose type stripping cannot resolve extensionless runtime
 * imports between source modules. Presentation lookups that need runtime data
 * (edge colours, block colours, edge-kind labels) are resolved by the component.
 */

/**
 * Every edge kind, in the order the panel lists its groups. Mirrors the edge
 * legend's order so the two overlays agree; it is duplicated rather than
 * imported because of the type-only-import rule above.
 */
export const DETAILS_EDGE_KINDS: readonly EdgeKind[] = [
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
];

export type EdgeDirection = "incoming" | "outgoing";

/** One "other endpoint" row: a node connected to the selected node. */
export interface EndpointRow {
  /** The other endpoint's node id (the click target). */
  nodeId: string;
  /** Endpoint's display name; derived from the id when the node is unknown. */
  name: string;
  /**
   * Secondary text: path for files/directories, signature for code blocks,
   * `null` when the node is unknown or carries neither.
   */
  detail: string | null;
  /** Block kind when the endpoint is a code block, for the badge colour. */
  blockKind: BlockKind | null;
  /** Edges of this group's kind between the selected node and this endpoint. */
  count: number;
  /** True when this endpoint IS the selected node (a self-loop edge). */
  selfLoop: boolean;
}

/** All edges of one kind in one direction. */
export interface EdgeKindGroup {
  kind: EdgeKind;
  /** Total edges of this kind in this direction (sum of endpoint counts). */
  count: number;
  endpoints: EndpointRow[];
}

export interface DirectionSection {
  direction: EdgeDirection;
  /** Total edges in this direction across all kinds. */
  total: number;
  /** Non-empty groups only, in `DETAILS_EDGE_KINDS` order. */
  groups: EdgeKindGroup[];
}

export interface DetailsEdgeModel {
  /** The selected node this model describes. */
  nodeId: string;
  incoming: DirectionSection;
  outgoing: DirectionSection;
}

/**
 * Name to show for an endpoint whose node is not in the graph map.
 *
 * Node ids are `path/to/file.ext` for files/directories and
 * `path/to/file.ext::name@line` for code blocks, so peeling the line suffix and
 * then the last `::` / `/` segment recovers the symbol or file name. Never
 * returns an empty string.
 */
export function fallbackEndpointName(id: string): string {
  if (!id) return "unknown";
  const withoutLine = id.replace(/@\d+$/, "");
  const afterColons = withoutLine.split("::").pop() ?? withoutLine;
  const afterSlash = afterColons.split("/").pop() ?? afterColons;
  return afterSlash || withoutLine || id;
}

/** Render a span as a line range, collapsing single-line spans. */
export function formatSpan(span: Span): string {
  return span.start_line === span.end_line
    ? `${span.start_line}`
    : `${span.start_line}–${span.end_line}`;
}

interface EndpointAccumulator {
  nodeId: string;
  count: number;
  selfLoop: boolean;
}

function emptySection(direction: EdgeDirection): DirectionSection {
  return { direction, total: 0, groups: [] };
}

/**
 * Split a depth-1 `Neighborhood` into the selected node's incoming and outgoing
 * edges, grouped by kind.
 *
 * Rules:
 * - A neighborhood focused on another node is discarded: the caller's fetch is
 *   stale (selection moved while it was in flight) and rendering it would
 *   attribute someone else's edges to the selection.
 * - A depth-1 neighborhood also contains neighbor-to-neighbor edges; only edges
 *   touching `nodeId` are described here.
 * - A self-loop is one edge, not two: it is listed in the OUTGOING section only
 *   (flagged `selfLoop`) so the counts stay equal to the number of edges.
 * - An edge counts 1 regardless of `weight` (weight is observation frequency,
 *   not a multiplier) -- the same rule the edge legend uses.
 */
export function buildDetailsEdgeModel(
  nodeId: string,
  neighborhood: Neighborhood | null,
  nodes: Readonly<Record<string, CodeNode>>
): DetailsEdgeModel {
  if (!neighborhood || neighborhood.focus !== nodeId) {
    return {
      nodeId,
      incoming: emptySection("incoming"),
      outgoing: emptySection("outgoing"),
    };
  }

  // kind -> endpoint id -> accumulator, per direction.
  const incoming = new Map<EdgeKind, Map<string, EndpointAccumulator>>();
  const outgoing = new Map<EdgeKind, Map<string, EndpointAccumulator>>();

  const bump = (
    buckets: Map<EdgeKind, Map<string, EndpointAccumulator>>,
    kind: EdgeKind,
    endpointId: string,
    selfLoop: boolean
  ) => {
    let byEndpoint = buckets.get(kind);
    if (!byEndpoint) {
      byEndpoint = new Map();
      buckets.set(kind, byEndpoint);
    }
    const existing = byEndpoint.get(endpointId);
    if (existing) {
      existing.count += 1;
    } else {
      byEndpoint.set(endpointId, { nodeId: endpointId, count: 1, selfLoop });
    }
  };

  for (const edge of neighborhood.edges) {
    const isSource = edge.source === nodeId;
    const isTarget = edge.target === nodeId;
    if (isSource && isTarget) {
      bump(outgoing, edge.kind, nodeId, true);
    } else if (isSource) {
      bump(outgoing, edge.kind, edge.target, false);
    } else if (isTarget) {
      bump(incoming, edge.kind, edge.source, false);
    }
  }

  return {
    nodeId,
    incoming: buildSection("incoming", incoming, nodes),
    outgoing: buildSection("outgoing", outgoing, nodes),
  };
}

function buildSection(
  direction: EdgeDirection,
  buckets: Map<EdgeKind, Map<string, EndpointAccumulator>>,
  nodes: Readonly<Record<string, CodeNode>>
): DirectionSection {
  const groups: EdgeKindGroup[] = [];
  let total = 0;

  for (const kind of DETAILS_EDGE_KINDS) {
    const byEndpoint = buckets.get(kind);
    if (!byEndpoint || byEndpoint.size === 0) continue;

    const endpoints = [...byEndpoint.values()]
      .map((acc) => toEndpointRow(acc, nodes))
      .sort(compareEndpoints);
    const count = endpoints.reduce((sum, e) => sum + e.count, 0);

    groups.push({ kind, count, endpoints });
    total += count;
  }

  return { direction, total, groups };
}

function toEndpointRow(
  acc: EndpointAccumulator,
  nodes: Readonly<Record<string, CodeNode>>
): EndpointRow {
  const node = nodes[acc.nodeId];
  return {
    nodeId: acc.nodeId,
    name: node ? node.name : fallbackEndpointName(acc.nodeId),
    detail: node ? endpointDetail(node) : null,
    blockKind: node && node.type === "CodeBlock" ? node.kind : null,
    count: acc.count,
    selfLoop: acc.selfLoop,
  };
}

function endpointDetail(node: CodeNode): string | null {
  switch (node.type) {
    case "Directory":
    case "File":
      return node.path;
    case "CodeBlock":
      return node.signature;
  }
}

/** Busiest endpoint first; ties broken by name then id so order is stable. */
function compareEndpoints(a: EndpointRow, b: EndpointRow): number {
  if (a.count !== b.count) return b.count - a.count;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

/** One labelled fact about the selected node. */
export interface NodeFact {
  label: string;
  value: string;
  /** Render in a monospace face (paths, signatures). */
  mono?: boolean;
}

/** Header content for the selected node. */
export interface NodeSummary {
  id: string;
  name: string;
  /** Badge text: "Directory", "File", or the block kind. */
  badge: string;
  /** Block kind when this is a code block, for the badge colour. */
  blockKind: BlockKind | null;
  /** Ordered facts; absent values are omitted rather than rendered empty. */
  facts: NodeFact[];
}

/** Describe the selected node: badge plus the facts worth showing for its type. */
export function buildNodeSummary(node: CodeNode): NodeSummary {
  const base = { id: node.id, name: node.name };

  switch (node.type) {
    case "Directory":
      return {
        ...base,
        badge: "Directory",
        blockKind: null,
        facts: [
          { label: "Path", value: node.path, mono: true },
          { label: "Items", value: `${node.children.length}` },
        ],
      };
    case "File":
      return {
        ...base,
        badge: "File",
        blockKind: null,
        facts: [
          { label: "Path", value: node.path, mono: true },
          { label: "Language", value: node.language ?? "Unknown" },
          { label: "Symbols", value: `${node.children.length}` },
        ],
      };
    case "CodeBlock": {
      const facts: NodeFact[] = [];
      if (node.signature) {
        facts.push({ label: "Signature", value: node.signature, mono: true });
      }
      if (node.visibility) {
        facts.push({ label: "Visibility", value: node.visibility });
      }
      facts.push({ label: "Lines", value: formatSpan(node.span) });
      return { ...base, badge: node.kind, blockKind: node.kind, facts };
    }
  }
}
