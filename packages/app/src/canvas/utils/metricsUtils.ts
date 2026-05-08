import type { CodeGraph, EdgeKind } from "../../api/types";

export interface NodeMetrics {
  fanIn: number;
  fanOut: number;
  symbolCount: number;
}

/**
 * Compute fan-in, fan-out, and symbol count metrics for all nodes in the graph.
 *
 * - fanIn: number of edges where this node is a target
 * - fanOut: number of edges where this node is a source
 * - symbolCount: total number of descendants (recursive children count)
 */
export function computeNodeMetrics(graph: CodeGraph): Map<string, NodeMetrics> {
  const metrics = new Map<string, NodeMetrics>();

  // Initialize all nodes with zero metrics
  for (const nodeId of Object.keys(graph.nodes)) {
    metrics.set(nodeId, { fanIn: 0, fanOut: 0, symbolCount: 0 });
  }

  // Single pass over edges for fanIn/fanOut
  for (const edge of graph.edges) {
    const sourceMetrics = metrics.get(edge.source);
    if (sourceMetrics) {
      sourceMetrics.fanOut++;
    }
    const targetMetrics = metrics.get(edge.target);
    if (targetMetrics) {
      targetMetrics.fanIn++;
    }
  }

  // Recursive symbol count (total descendants)
  const symbolCountCache = new Map<string, number>();

  function getSymbolCount(nodeId: string): number {
    const cached = symbolCountCache.get(nodeId);
    if (cached !== undefined) return cached;

    const node = graph.nodes[nodeId];
    if (!node) {
      symbolCountCache.set(nodeId, 0);
      return 0;
    }

    let count = node.children.length;
    for (const childId of node.children) {
      count += getSymbolCount(childId);
    }

    symbolCountCache.set(nodeId, count);
    return count;
  }

  for (const nodeId of Object.keys(graph.nodes)) {
    const m = metrics.get(nodeId)!;
    m.symbolCount = getSymbolCount(nodeId);
  }

  return metrics;
}

/**
 * BFS to find all transitively connected nodes from a starting node.
 *
 * - upstream: follow edges where target === current (find what depends on this node)
 * - downstream: follow edges where source === current (find what this node depends on)
 * - both: follow edges in both directions
 *
 * Returns the set of all node IDs in the dependency chain, including the start node.
 */
export function computeDependencyChain(
  graph: CodeGraph,
  startNodeId: string,
  direction: "upstream" | "downstream" | "both",
  enabledEdgeKinds: Set<EdgeKind>
): Set<string> {
  const chain = new Set<string>();
  const queue: string[] = [startNodeId];
  chain.add(startNodeId);

  // Build adjacency maps for efficient traversal
  const outgoing = new Map<string, string[]>(); // source -> targets
  const incoming = new Map<string, string[]>(); // target -> sources

  for (const edge of graph.edges) {
    if (!enabledEdgeKinds.has(edge.kind)) continue;

    if (direction === "downstream" || direction === "both") {
      if (!outgoing.has(edge.source)) {
        outgoing.set(edge.source, []);
      }
      outgoing.get(edge.source)!.push(edge.target);
    }

    if (direction === "upstream" || direction === "both") {
      if (!incoming.has(edge.target)) {
        incoming.set(edge.target, []);
      }
      incoming.get(edge.target)!.push(edge.source);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;

    // Follow downstream edges (source -> target)
    if (direction === "downstream" || direction === "both") {
      const targets = outgoing.get(current);
      if (targets) {
        for (const target of targets) {
          if (!chain.has(target)) {
            chain.add(target);
            queue.push(target);
          }
        }
      }
    }

    // Follow upstream edges (target -> source)
    if (direction === "upstream" || direction === "both") {
      const sources = incoming.get(current);
      if (sources) {
        for (const source of sources) {
          if (!chain.has(source)) {
            chain.add(source);
            queue.push(source);
          }
        }
      }
    }
  }

  return chain;
}

/**
 * Normalize a metric across all nodes to a 0-1 scale.
 *
 * Returns a map from node ID to normalized value.
 * If all values are the same (max === min), all nodes get 0.
 */
export function normalizeMetrics(
  metrics: Map<string, NodeMetrics>,
  metric: keyof NodeMetrics
): Map<string, number> {
  const result = new Map<string, number>();

  let min = Infinity;
  let max = -Infinity;

  for (const [, m] of metrics) {
    const value = m[metric];
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const range = max - min;

  for (const [nodeId, m] of metrics) {
    const value = m[metric];
    result.set(nodeId, range > 0 ? (value - min) / range : 0);
  }

  return result;
}
