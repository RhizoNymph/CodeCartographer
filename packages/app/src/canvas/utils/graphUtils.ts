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
