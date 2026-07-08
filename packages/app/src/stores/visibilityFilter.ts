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

export function computeConnectedVisibleNodes(
  graph: CodeGraph,
  visibleNodes: Set<string>,
  enabledEdgeKinds: Set<EdgeKind>
): Set<string> {
  const parentByNodeId = buildParentMap(graph);
  const connected = new Set<string>();

  for (const edge of graph.edges) {
    if (
      !enabledEdgeKinds.has(edge.kind) ||
      !graph.nodes[edge.source] ||
      !graph.nodes[edge.target]
    ) {
      continue;
    }

    const visibleSource = findNearestVisibleAncestor(
      edge.source,
      graph,
      visibleNodes,
      parentByNodeId
    );
    const visibleTarget = findNearestVisibleAncestor(
      edge.target,
      graph,
      visibleNodes,
      parentByNodeId
    );

    if (!visibleSource || !visibleTarget || visibleSource === visibleTarget) {
      continue;
    }

    addNodeAndAncestors(visibleSource, graph, parentByNodeId, connected);
    addNodeAndAncestors(visibleTarget, graph, parentByNodeId, connected);
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
