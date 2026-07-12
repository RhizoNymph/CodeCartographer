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

export type ParseEvent =
  | { type: "FileStart"; path: string }
  | { type: "FileDone"; path: string; blocks: number }
  | { type: "Error"; path: string; message: string }
  | { type: "Complete"; total_files: number; total_blocks: number };

// Edge kind colors matching Rust
export const EDGE_COLORS: Record<EdgeKind, string> = {
  Import: "#6366f1",
  FunctionCall: "#22c55e",
  MethodCall: "#14b8a6",
  TypeReference: "#f59e0b",
  Inheritance: "#ef4444",
  TraitImpl: "#a855f7",
  VariableUsage: "#64748b",
};

// Block kind colors
export const BLOCK_COLORS: Record<BlockKind, string> = {
  Function: "#3b82f6",
  Class: "#8b5cf6",
  Struct: "#f59e0b",
  Enum: "#10b981",
  Trait: "#ec4899",
  Interface: "#06b6d4",
  Impl: "#6366f1",
  Module: "#64748b",
  Constant: "#f97316",
  TypeAlias: "#14b8a6",
};

// Node type colors
export const NODE_COLORS = {
  Directory: "#1e293b",
  File: "#1e3a5f",
};
