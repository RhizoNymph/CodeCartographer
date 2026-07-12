import type { CodeGraph, EdgeKind } from "../api/types";

function buildParentMap(graph: CodeGraph): Map<string, string> {
  const parentByNodeId = new Map<string, string>();

  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    for (const childId of node.children) {
      parentByNodeId.set(childId, nodeId);
    }
  }

  return parentByNodeId;
}

function addNodeAndAncestors(
  nodeId: string,
  graph: CodeGraph,
  parentByNodeId: Map<string, string>,
  result: Set<string>
) {
  let current: string | undefined = nodeId;

  while (current && graph.nodes[current] && !result.has(current)) {
    result.add(current);
    current = parentByNodeId.get(current);
  }
}

function findNearestVisibleAncestor(
  nodeId: string,
  graph: CodeGraph,
  visibleNodes: Set<string>,
  parentByNodeId: Map<string, string>
): string | null {
  let current: string | undefined = nodeId;

  while (current && graph.nodes[current]) {
    if (visibleNodes.has(current)) {
      return current;
    }
    current = parentByNodeId.get(current);
  }

  return null;
}

/**
 * Whether a node is an endpoint of at least one edge whose kind is enabled,
 * using the connectivity map returned by the backend (`nodeEdgeKinds`).
 */
function nodeHasEnabledEdge(
  graph: CodeGraph,
  nodeId: string,
  enabledEdgeKinds: Set<EdgeKind>
): boolean {
  const kinds = graph.nodeEdgeKinds.get(nodeId);
  if (!kinds) return false;
  for (const kind of kinds) {
    if (enabledEdgeKinds.has(kind)) return true;
  }
  return false;
}

/**
 * Compute the set of visible nodes that are connected through an enabled edge,
 * plus their ancestors. Edges live server-side; connectivity is derived
 * synchronously from the per-node `nodeEdgeKinds` map. A node is treated as
 * connected if it -- or any descendant that collapses up into it -- is an
 * endpoint of an enabled-kind edge. Its nearest visible ancestor and that
 * ancestor's ancestors are retained.
 */
export function computeConnectedVisibleNodes(
  graph: CodeGraph,
  visibleNodes: Set<string>,
  enabledEdgeKinds: Set<EdgeKind>
): Set<string> {
  const parentByNodeId = buildParentMap(graph);
  const connected = new Set<string>();

  for (const nodeId of graph.nodeEdgeKinds.keys()) {
    if (!graph.nodes[nodeId]) continue;
    if (!nodeHasEnabledEdge(graph, nodeId, enabledEdgeKinds)) continue;

    const visibleAncestor = findNearestVisibleAncestor(
      nodeId,
      graph,
      visibleNodes,
      parentByNodeId
    );
    if (!visibleAncestor) continue;

    addNodeAndAncestors(visibleAncestor, graph, parentByNodeId, connected);
  }

  return connected;
}

export function computeDisplayVisibleNodes(
  graph: CodeGraph | null,
  visibleNodes: Set<string>,
  enabledEdgeKinds: Set<EdgeKind>,
  hideUnconnectedNodes: boolean
): Set<string> {
  if (!graph || !hideUnconnectedNodes) {
    return new Set(visibleNodes);
  }

  const connected = computeConnectedVisibleNodes(graph, visibleNodes, enabledEdgeKinds);
  const filtered = new Set<string>();

  for (const nodeId of visibleNodes) {
    if (connected.has(nodeId)) {
      filtered.add(nodeId);
    }
  }

  return filtered;
}
