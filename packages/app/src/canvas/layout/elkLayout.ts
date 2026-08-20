import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk-api";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import type { CodeGraph, CodeNode, EdgeKind } from "../../api/types";
import { useDebugStore } from "../../stores/debugStore";
import {
  unknownEdgeKindCounts,
  type EdgeKindCounts,
} from "../legend/edgeLegendModel";
import { elkEdgeId } from "./elkEdgeId";
import { extractNodePositions, extractRoutedEdges } from "./elkExtract";
import { getNodeSize } from "../utils/graphUtils";
import { fetchViewEdges, type ViewEdge } from "./viewEdges";
import { straightLineEdges } from "./straightEdges";
import type { LayoutNodePosition, LayoutResult } from "./layoutTypes";
import {
  LAYOUT_EDGE_ROUTING_EDGE_LIMIT,
  LAYOUT_EDGE_ROUTING_NODE_LIMIT,
  shouldSkipLayoutEdgeRouting,
} from "./edgeRoutingBudget";

/**
 * The POSITIONS phase of the layout pipeline: build the ELK containment tree for
 * the current node set, fetch the view edges for that render set, and let ELK
 * solve node placement + orthogonal edge routing in its web worker.
 *
 * This is the expensive phase and the only one that produces node positions, so
 * it runs only when the node-position problem actually changed -- see
 * `stores/relayoutPolicy` for the trigger policy and `edgePhase.ts` for the
 * cheap edge-only rerun. ELK edge routing is additionally skipped above the
 * node/edge limits in `edgeRoutingBudget` (straight-line fallback).
 */

const elk = new ELK({ workerFactory: () => new ElkWorker() });

/**
 * One DEV-only debug line. Funnels what used to be a dozen copies of
 * `if (import.meta.env.DEV) useDebugStore.getState().addLog(...)`.
 */
function debugLog(message: string): void {
  if (import.meta.env.DEV) {
    useDebugStore.getState().addLog(message);
  }
}

export type { LayoutEdge, LayoutNodePosition, LayoutResult } from "./layoutTypes";

function buildElkNode(
  nodeId: string,
  node: CodeNode,
  graph: CodeGraph,
  expandedNodes: Set<string>,
  visibleNodes: Set<string>,
  depth: number
): ElkNode | null {
  if (!visibleNodes.has(nodeId)) return null;

  const size = getNodeSize(node);
  const elkNode: ElkNode = {
    id: nodeId,
    width: size.width,
    height: size.height,
    labels: [{ text: node.name }],
  };

  // Add children if expanded
  if (expandedNodes.has(nodeId) && node.children.length > 0) {
    const children: ElkNode[] = [];
    for (const childId of node.children) {
      const childNode = graph.nodes[childId];
      if (childNode && visibleNodes.has(childId)) {
        const childElk = buildElkNode(
          childId,
          childNode,
          graph,
          expandedNodes,
          visibleNodes,
          depth + 1
        );
        if (childElk) {
          children.push(childElk);
        }
      }
    }

    if (children.length > 0) {
      elkNode.children = children;
      elkNode.layoutOptions = {
        "elk.padding": "[top=30,left=10,bottom=10,right=10]",
      };
      // Let ELK size the parent based on children
      delete elkNode.width;
      delete elkNode.height;
    }
  }

  return elkNode;
}

export async function layoutGraph(
  graph: CodeGraph,
  expandedNodes: Set<string>,
  visibleNodes: Set<string>,
  enabledEdgeKinds?: Set<EdgeKind>,
  hideAmbiguousEdges = false
): Promise<LayoutResult> {
  const rootNode = graph.nodes[graph.root];
  if (!rootNode) {
    return emptyLayout();
  }

  // Build ELK graph
  const children: ElkNode[] = [];
  for (const childId of rootNode.children) {
    const childNode = graph.nodes[childId];
    if (childNode && visibleNodes.has(childId)) {
      const elkNode = buildElkNode(
        childId,
        childNode,
        graph,
        expandedNodes,
        visibleNodes,
        0
      );
      if (elkNode) {
        children.push(elkNode);
      }
    }
  }

  // Collect all node IDs that are actually in the ELK tree (visible nodes whose
  // ancestors are all expanded). This is the render set sent to the backend.
  const elkNodeIds = new Set<string>();
  function collectElkNodeIds(nodes: ElkNode[]) {
    for (const n of nodes) {
      elkNodeIds.add(n.id);
      if (n.children) collectElkNodeIds(n.children);
    }
  }
  collectElkNodeIds(children);

  // Fetch per-view edges (direct + aggregated) from server-side graph state.
  const renderIds = Array.from(elkNodeIds);
  const { viewEdges, edgeKindCounts } = await fetchViewEdges(
    renderIds,
    enabledEdgeKinds,
    hideAmbiguousEdges
  );

  // Layout guard: for very large views, skip ELK orthogonal edge routing and let
  // extractLayout produce straight-line fallback edges. Routing cost is driven
  // by EDGES as much as nodes, so both counts gate it -- a 1400-node view
  // carrying 20k edges is just as unroutable as a 5000-node one.
  const skipEdgeRouting = shouldSkipLayoutEdgeRouting(elkNodeIds.size, viewEdges.length);
  if (skipEdgeRouting) {
    debugLog(
      `Large view (${elkNodeIds.size} nodes / ${viewEdges.length} edges exceeds ` +
        `${LAYOUT_EDGE_ROUTING_NODE_LIMIT} nodes or ${LAYOUT_EDGE_ROUTING_EDGE_LIMIT} edges): ` +
        `skipping edge routing. ` +
        `Consider Module view or collapsing containers for cleaner routing.`
    );
  }

  debugLog(
    `View edges: total=${viewEdges.length}, elkNodes=${elkNodeIds.size}, routing=${!skipEdgeRouting}`
  );

  // Build ELK edge inputs (omitted entirely when skipping routing). The id
  // encodes the viewEdges index so extraction can map each routed edge back to
  // exactly the view edge it came from (parallel same-pair edges included).
  const elkEdges: ElkExtendedEdge[] = skipEdgeRouting
    ? []
    : viewEdges.map((e, i) => ({
        id: elkEdgeId(i),
        sources: [e.source],
        targets: [e.target],
      }));

  const elkGraph: ElkNode = {
    id: "root",
    children,
    edges: elkEdges,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "26",
      "elk.spacing.edgeNode": "24",
      "elk.spacing.edgeEdge": "12",
      "elk.layered.spacing.nodeNodeBetweenLayers": "44",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.padding": "[top=30,left=15,bottom=15,right=15]",
    },
  };

  try {
    debugLog(`ELK layout starting...`);
    const laidOut = await elk.layout(elkGraph);
    debugLog(`ELK layout done, extracting...`);
    const result = extractLayout(laidOut, viewEdges, edgeKindCounts, renderIds);
    if (import.meta.env.DEV) {
      debugLog(`ELK extracted ${result.edges.length} edges`);

      // Update debug store (kept inline: these scans are too expensive to run
      // outside a DEV guard).
      const codeBlocksInGraph = Object.values(graph.nodes).filter(n => n.type === "CodeBlock").length;
      const filesWithChildren = Object.values(graph.nodes).filter(n => n.type === "File" && n.children.length > 0).length;
      const expandedFiles = Array.from(expandedNodes).filter(id => graph.nodes[id]?.type === "File").length;
      useDebugStore.getState().setLayoutInfo({
        elkNodeIds: elkNodeIds.size,
        edgesInTree: viewEdges.length,
        edgesNotInTree: 0,
        aggregatedEdges: viewEdges.filter((e) => e.count > 1).length,
        elkEdgesInput: elkEdges.length,
        elkEdgesOutput: result.edges.length,
        edgesWithSections: result.edges.length, // approximate
        edgesWithoutSections: elkEdges.length - result.edges.length,
        sampleGraphEdge: JSON.stringify(viewEdges[0]),
        sampleElkNodeId: renderIds[0] ?? "none",
        codeBlocksInGraph,
        filesWithChildren,
        expandedFiles,
      });
    }

    return result;
  } catch (err) {
    console.error("ELK layout failed:", err);
    debugLog(`ELK FAILED: ${err}`);
    return fallbackLayout(graph, visibleNodes, edgeKindCounts, renderIds);
  }
}

function emptyLayout(): LayoutResult {
  return {
    nodes: {},
    edges: [],
    edgeKindCounts: unknownEdgeKindCounts(),
    renderIds: [],
  };
}

/**
 * ELK's answer, turned into a `LayoutResult`.
 *
 * Composition only: positions, then routed edges, then the straight-line
 * fallback for when ELK routed nothing. Each step is a pure function in
 * `elkExtract.ts`; what stays here is the DEV logging and the fallback policy.
 */
function extractLayout(
  elkNode: ElkNode,
  viewEdges: ViewEdge[],
  edgeKindCounts: EdgeKindCounts,
  renderIds: string[]
): LayoutResult {
  const nodes = extractNodePositions(elkNode);
  const { edges, stats } = extractRoutedEdges(elkNode, nodes, viewEdges);

  debugLog(
    `extractLayout: found=${stats.totalEdgesFound}, withSections=${stats.edgesWithSections}, ` +
      `withoutSections=${stats.edgesWithoutSections}, result=${edges.length}`
  );

  // If ELK didn't route edges (either it produced none, or routing was skipped
  // for a large view), generate straight-line fallback edges from the view edges.
  if (edges.length === 0 && viewEdges.length > 0) {
    debugLog("ELK provided no routed edges, generating straight-line fallback edges");
    // Appended one at a time: this path exists for the very views that skipped
    // ELK routing, and a spread of tens of thousands of edges overflows the
    // call stack.
    for (const edge of straightLineEdges(nodes, viewEdges)) {
      edges.push(edge);
    }
    debugLog(`Generated ${edges.length} fallback edges`);
  }

  return { nodes, edges, edgeKindCounts, renderIds };
}

function fallbackLayout(
  graph: CodeGraph,
  visibleNodes: Set<string>,
  edgeKindCounts: EdgeKindCounts,
  renderIds: string[]
): LayoutResult {
  const nodes: Record<string, LayoutNodePosition> = {};
  let x = 20;
  let y = 20;
  const colWidth = 220;
  const rowHeight = 50;
  let col = 0;
  const maxCols = 8;

  for (const nodeId of visibleNodes) {
    const node = graph.nodes[nodeId];
    if (!node) continue;

    const size = getNodeSize(node);
    nodes[nodeId] = {
      x: x + col * colWidth,
      y,
      width: size.width,
      height: size.height,
    };

    col++;
    if (col >= maxCols) {
      col = 0;
      y += rowHeight + 10;
    }
  }

  return { nodes, edges: [], edgeKindCounts, renderIds };
}
