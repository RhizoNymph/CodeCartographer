// Types matching the Rust data model

export interface Span {
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

export type BlockKind =
  | "Function"
  | "Class"
  | "Struct"
  | "Enum"
  | "Trait"
  | "Interface"
  | "Impl"
  | "Module"
  | "Constant"
  | "TypeAlias";

export type Visibility = "Public" | "Private" | "Protected" | "Crate";

export type Language = "Python" | "TypeScript" | "JavaScript" | "Rust";

export type EdgeKind =
  | "Import"
  | "FunctionCall"
  | "MethodCall"
  | "TypeReference"
  | "Inheritance"
  | "TraitImpl"
  | "VariableUsage";

/**
 * How confidently a reference was resolved to its target. Matches the Rust
 * `Resolution` enum's serde output (externally-tagged unit variants serialize
 * to their plain variant name). Ordered worst -> best.
 */
export type Resolution =
  | "Ambiguous"
  | "GlobalUnique"
  | "Imported"
  | "SameFile";

export interface DirectoryNode {
  type: "Directory";
  id: string;
  name: string;
  path: string;
  children: string[];
}

export interface FileNode {
  type: "File";
  id: string;
  name: string;
  path: string;
  language: Language | null;
  children: string[];
}

export interface CodeBlockNode {
  type: "CodeBlock";
  id: string;
  name: string;
  kind: BlockKind;
  span: Span;
  signature: string | null;
  visibility: Visibility | null;
  parent: string;
  children: string[];
}

export type CodeNode = DirectoryNode | FileNode | CodeBlockNode;

export interface CodeEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
  resolution: Resolution;
}

export interface AggregatedEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  count: number;
}

/**
 * The node graph held by the frontend. Edges live only in server-side state;
 * per-view edges are fetched on demand via `get_subgraph`. `nodeEdgeKinds`
 * records, for each node touched by an edge, the distinct edge kinds touching
 * it, so connectivity filtering can run synchronously without edges.
 */
export interface CodeGraph {
  nodes: Record<string, CodeNode>;
  root: string;
  /** Total edge count in the backing graph (for UI counts). */
  edgeCount: number;
  /** node id -> distinct edge kinds touching that node. */
  nodeEdgeKinds: Map<string, EdgeKind[]>;
}

/**
 * Raw edge-less parse response from the `parse_repo` command. Converted into a
 * `CodeGraph` (with Map-based connectivity) by graphStore.
 */
export interface ParseResult {
  nodes: Record<string, CodeNode>;
  root: string;
  edge_count: number;
  node_edge_kinds: Record<string, EdgeKind[]>;
}

/**
 * Per-view edges computed server-side by `get_subgraph`. The frontend already
 * holds the node tree, so only edges are returned.
 */
export interface SubGraph {
  edges: CodeEdge[];
  aggregated_edges: AggregatedEdge[];
}

/**
 * Which way a focus trace walks the graph: `upstream` follows callers only,
 * `downstream` callees only, `both` (the default) is the bidirectional
 * neighborhood. Wire format of cc-core's `FocusDirection`.
 */
export type FocusDirection = "both" | "upstream" | "downstream";

/**
 * A local neighborhood around a focus node, returned by `get_neighborhood` for
 * focus / drill-down. `node_ids` includes the BFS frontier plus the container
 * chain (parents up to root) of every discovered node so the frontend can build
 * the ELK containment tree; `edges` are the direct edges (with resolution) among
 * the discovered nodes. `direction` echoes the traced direction back.
 */
export interface Neighborhood {
  focus: string;
  depth: number;
  direction: FocusDirection;
  node_ids: string[];
  edges: CodeEdge[];
}

/**
 * The underlying edges behind ONE aggregated view edge, returned by
 * `get_edge_detail` when the user drills into an aggregated edge. `edges` are
 * the graph edges running from the `source` subtree into the `target` subtree
 * (that direction only); `node_ids` are their endpoints plus the container chain
 * up to the root, using the same convention as `Neighborhood.node_ids` so the
 * ELK containment tree builds identically.
 */
export interface EdgeDetail {
  source: string;
  target: string;
  node_ids: string[];
  edges: CodeEdge[];
}

export type ParseEvent =
  | { type: "FileStart"; path: string }
  | { type: "FileDone"; path: string; blocks: number }
  | { type: "Error"; path: string; message: string }
  | { type: "Complete"; total_files: number; total_blocks: number };

/**
 * The palette is built around one rule: a colour identifies exactly one
 * category. Edges own the saturated end of the spectrum and blocks/nodes own
 * the muted end, so an edge hue never reads as a node fill and vice versa.
 *
 * Edges get five hues -- as many as a user can reliably hold in working memory.
 * Kinds that answer the same question share a hue: FunctionCall and MethodCall
 * are both "a call", Inheritance and TraitImpl are both "a subtype relation".
 * The kinds stay distinct everywhere else (model, tooltips, toggles, styles);
 * only the colour merges.
 */
export const EDGE_HUES = {
  /** Module-view flagship edge. Indigo -- reserved, never reused by a block. */
  import: "#818cf8",
  /** FunctionCall + MethodCall. */
  calls: "#4ade80",
  typeReference: "#fbbf24",
  /** Inheritance + TraitImpl. */
  subtype: "#f472b6",
  /** Deliberately neutral: the noisiest, least informative edge kind. */
  variableUsage: "#94a3b8",
} as const;

// Edge kind colors. Distinct hues: 5 (see EDGE_HUES).
export const EDGE_COLORS: Record<EdgeKind, string> = {
  Import: EDGE_HUES.import,
  FunctionCall: EDGE_HUES.calls,
  MethodCall: EDGE_HUES.calls,
  TypeReference: EDGE_HUES.typeReference,
  Inheritance: EDGE_HUES.subtype,
  TraitImpl: EDGE_HUES.subtype,
  VariableUsage: EDGE_HUES.variableUsage,
};

/**
 * Block kind colors: one muted family (HSL saturation 42%, lightness 62%) so
 * node fills recede into the background and edges pop against them. Hues avoid
 * the indigo/slate band owned by the Import and VariableUsage edges -- which is
 * why Impl (was indigo, collided with Import) and Module (was slate, collided
 * with VariableUsage) moved to lime and clay.
 */
export const BLOCK_COLORS: Record<BlockKind, string> = {
  Function: "#758fc7", // blue
  Class: "#bb75c7", // purple
  Struct: "#c7b775", // sand
  Enum: "#75c787", // green
  Trait: "#c7759e", // rose
  Interface: "#75bdc7", // cyan
  Impl: "#a9c775", // lime
  Module: "#c77b75", // clay
  Constant: "#c79975", // tan
  TypeAlias: "#75c7ad", // teal
};

// Node type colors
export const NODE_COLORS = {
  Directory: "#1e293b",
  File: "#1e3a5f",
};
