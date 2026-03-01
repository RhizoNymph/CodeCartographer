// Types matching the Rust data model

export interface NodeId {
  id: string;
}

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

export interface CodeGraph {
  nodes: Record<string, CodeNode>;
  edges: CodeEdge[];
  root: string;
}

export interface SubGraph {
  nodes: CodeNode[];
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
