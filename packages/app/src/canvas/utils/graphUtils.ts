import type { CodeGraph, CodeNode } from "../../api/types";

/**
 * Build a map from each node to its parent.
 * Shared by elkLayout and PixiRenderer.
 */
export function buildParentMap(graph: CodeGraph): Map<string, string> {
  const parentMap = new Map<string, string>();
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    for (const childId of node.children) {
      parentMap.set(childId, nodeId);
    }
  }
  return parentMap;
}

/**
 * Get the minimum size for a node based on its type.
 * Shared by elkLayout and PixiRenderer.
 */
export function getNodeSize(node: CodeNode): { width: number; height: number } {
  switch (node.type) {
    case "Directory":
      return { width: 200, height: 60 };
    case "File":
      return { width: 180, height: 40 };
    case "CodeBlock":
      return { width: 160, height: 32 };
  }
}

/**
 * Walk the parent chain from a given node to the root, returning
 * an ordered path from root to the node (inclusive).
 */
export function getNodeAncestorPath(nodeId: string, graph: CodeGraph): string[] {
  const parentMap = buildParentMap(graph);
  const path: string[] = [];
  let current: string | undefined = nodeId;

  while (current) {
    path.push(current);
    current = parentMap.get(current);
  }

  path.reverse();
  return path;
}
