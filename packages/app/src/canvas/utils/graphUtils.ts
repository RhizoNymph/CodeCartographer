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

export function isAncestorOf(
  maybeAncestor: string,
  nodeId: string,
  parentMap: Map<string, string>
): boolean {
  let current = parentMap.get(nodeId);

  while (current) {
    if (current === maybeAncestor) {
      return true;
    }
    current = parentMap.get(current);
  }

  return false;
}

/**
 * Get the minimum size for a node based on its type.
 * Shared by elkLayout and PixiRenderer.
 */
export function getNodeSize(node: CodeNode): { width: number; height: number } {
  switch (node.type) {
    case "Directory":
      return { width: 220, height: 70 };
    case "File":
      return { width: 180, height: 44 };
    case "CodeBlock":
      return { width: 150, height: 28 };
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
