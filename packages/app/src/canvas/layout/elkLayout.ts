import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk-api";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import type { CodeGraph, CodeNode, EdgeKind, Resolution } from "../../api/types";
import { EDGE_COLORS } from "../../api/types";
import { getSubgraph } from "../../api/commands";
import { useDebugStore } from "../../stores/debugStore";
import {
  deriveEdgeKindCounts,
  unknownEdgeKindCounts,
  type EdgeKindCounts,
} from "../legend/edgeLegendModel";
import {
  anchorEdgePolyline,
  dedupePolylinePoints,
  inferEdgeAnchor,
  type EdgeAnchor,
  type Point,
} from "./edgeGeometry";
import { getNodeSize } from "../utils/graphUtils";

const elk = new ELK({ workerFactory: () => new ElkWorker() });

/** Above this many rendered nodes, ELK edge routing is skipped for performance. */
const EDGE_ROUTING_NODE_LIMIT = 1500;

const ALL_EDGE_KINDS: EdgeKind[] = [
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
];

/**
 * A view edge with resolved display info, ready to feed to ELK and extractLayout.
 * `kind` is null-safe: aggregated edges carry the kind of the first underlying
 * edge; `count` drives tooltip counts and edge-width scaling. `resolution` is
 * null for aggregated edges (no single confidence) and carries the direct
 * edge's confidence otherwise (drives ambiguous styling).
 */
interface ViewEdge {
  source: string;
  target: string;
  color: string;
  kind: EdgeKind | null;
  count: number;
  resolution: Resolution | null;
}

export interface LayoutNodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
  color: string;
  kind: EdgeKind | null; // null when the underlying kind is unknown
  /** Number of underlying edges (1 for direct, N for aggregated). Drives tooltip count + width. */
  count: number;
  /** Resolution confidence for direct edges; null for aggregated edges. */
  resolution: Resolution | null;
  points: Point[];
  sourceAnchor: EdgeAnchor;
  targetAnchor: EdgeAnchor;
}

export interface LayoutResult {
  nodes: Record<string, LayoutNodePosition>;
  edges: LayoutEdge[];
  /**
   * Underlying edge counts per kind for this view, derived from the fetched
   * `SubGraph`. Kinds that were not requested are `null` (unknown). Published to
   * `edgeLegendStore` by the renderer once the layout is known to be current.
   */
  edgeKindCounts: EdgeKindCounts;
}

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
    return { nodes: {}, edges: [], edgeKindCounts: unknownEdgeKindCounts() };
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
  const enabledKinds = enabledEdgeKinds
    ? Array.from(enabledEdgeKinds)
    : ALL_EDGE_KINDS;

  let viewEdges: ViewEdge[] = [];
  // Per-kind counts for the legend, derived from the same payload the layout
  // uses. Kinds outside `enabledKinds` were never fetched and stay unknown.
  let edgeKindCounts: EdgeKindCounts = unknownEdgeKindCounts();
  try {
    const sub = await getSubgraph(renderIds, enabledKinds);
    edgeKindCounts = deriveEdgeKindCounts(sub, enabledKinds, hideAmbiguousEdges);
    for (const e of sub.edges) {
      // Ambiguous direct edges can be hidden client-side (imports are exact so
      // this only ever affects reference edges).
      if (hideAmbiguousEdges && e.resolution === "Ambiguous") continue;
      viewEdges.push({
        source: e.source,
        target: e.target,
        color: EDGE_COLORS[e.kind] || "#64748b",
        kind: e.kind,
        count: e.weight,
        resolution: e.resolution,
      });
    }
    for (const ae of sub.aggregated_edges) {
      viewEdges.push({
        source: ae.source,
        target: ae.target,
        color: EDGE_COLORS[ae.kind] || "#64748b",
        kind: ae.kind,
        count: ae.count,
        resolution: null,
      });
    }
  } catch (err) {
    console.error("getSubgraph failed:", err);
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`getSubgraph FAILED: ${err}`);
    }
    viewEdges = [];
  }

  // Layout guard: for very large views, skip ELK orthogonal edge routing and let
  // extractLayout produce straight-line fallback edges. Routing thousands of
  // edges is prohibitively slow.
  const skipEdgeRouting = elkNodeIds.size > EDGE_ROUTING_NODE_LIMIT;
  if (skipEdgeRouting && import.meta.env.DEV) {
    useDebugStore.getState().addLog(
      `Large view (${elkNodeIds.size} nodes > ${EDGE_ROUTING_NODE_LIMIT}): skipping edge routing. ` +
        `Consider Module view or collapsing containers for cleaner routing.`
    );
  }

  if (import.meta.env.DEV) {
    useDebugStore.getState().addLog(
      `View edges: total=${viewEdges.length}, elkNodes=${elkNodeIds.size}, routing=${!skipEdgeRouting}`
    );
  }

  // Build ELK edge inputs (omitted entirely when skipping routing).
  const elkEdges: ElkExtendedEdge[] = skipEdgeRouting
    ? []
    : viewEdges.map((e, i) => ({
        id: `edge-${i}`,
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

  // Index view edges by source->target for lookup during extraction.
  const viewEdgeInfo = new Map<string, ViewEdge>();
  for (const ve of viewEdges) {
    const key = `${ve.source}->${ve.target}`;
    if (!viewEdgeInfo.has(key)) viewEdgeInfo.set(key, ve);
  }

  try {
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`ELK layout starting...`);
    }
    const laidOut = await elk.layout(elkGraph);
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`ELK layout done, extracting...`);
    }
    const result = extractLayout(laidOut, viewEdges, viewEdgeInfo, edgeKindCounts);
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`ELK extracted ${result.edges.length} edges`);

      // Update debug store
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
        sampleElkNodeId: Array.from(elkNodeIds)[0] ?? "none",
        codeBlocksInGraph,
        filesWithChildren,
        expandedFiles,
      });
    }

    return result;
  } catch (err) {
    console.error("ELK layout failed:", err);
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`ELK FAILED: ${err}`);
    }
    return fallbackLayout(graph, visibleNodes, edgeKindCounts);
  }
}

function extractLayout(
  elkNode: ElkNode,
  viewEdges: ViewEdge[],
  viewEdgeInfo: Map<string, ViewEdge>,
  edgeKindCounts: EdgeKindCounts
): LayoutResult {
  const result: LayoutResult = { nodes: {}, edges: [], edgeKindCounts };

  let edgesWithSections = 0;
  let edgesWithoutSections = 0;
  let totalEdgesFound = 0;

  function processNode(node: ElkNode, offsetX: number, offsetY: number) {
    if (node.id !== "root") {
      result.nodes[node.id] = {
        x: offsetX + (node.x || 0),
        y: offsetY + (node.y || 0),
        width: node.width || 100,
        height: node.height || 40,
      };
    }

    const nx = offsetX + (node.x || 0);
    const ny = offsetY + (node.y || 0);

    if (node.children) {
      for (const child of node.children) {
        processNode(child, nx, ny);
      }
    }

    if (node.edges) {
      if (import.meta.env.DEV) { totalEdgesFound += node.edges.length; }
      for (const edge of node.edges) {
        const sourceId = edge.sources[0];
        const targetId = edge.targets[0];

        const info = viewEdgeInfo.get(`${sourceId}->${targetId}`);
        const color = info?.color ?? "#64748b";
        const kind = info?.kind ?? null;
        const count = info?.count ?? 1;
        const resolution = info?.resolution ?? null;

        const points: Point[] = [];
        if (edge.sections) {
          if (import.meta.env.DEV) { edgesWithSections++; }
          for (const section of edge.sections) {
            points.push({
              x: nx + section.startPoint.x,
              y: ny + section.startPoint.y,
            });
            if (section.bendPoints) {
              for (const bp of section.bendPoints) {
                points.push({ x: nx + bp.x, y: ny + bp.y });
              }
            }
            points.push({
              x: nx + section.endPoint.x,
              y: ny + section.endPoint.y,
            });
          }
        } else {
          if (import.meta.env.DEV) { edgesWithoutSections++; }
          // Fallback: draw straight line between node centers
          const sourcePos = result.nodes[sourceId];
          const targetPos = result.nodes[targetId];
          if (sourcePos && targetPos) {
            points.push({
              x: sourcePos.x + sourcePos.width / 2,
              y: sourcePos.y + sourcePos.height / 2,
            });
            points.push({
              x: targetPos.x + targetPos.width / 2,
              y: targetPos.y + targetPos.height / 2,
            });
          }
        }

        if (points.length >= 2) {
          const sourcePos = result.nodes[sourceId];
          const targetPos = result.nodes[targetId];
          if (!sourcePos || !targetPos) {
            continue;
          }

          const normalizedPoints = dedupePolylinePoints(points);
          if (normalizedPoints.length < 2) {
            continue;
          }

          const sourceAnchor = inferEdgeAnchor(
            sourcePos,
            normalizedPoints[0],
            normalizedPoints[1]
          );
          const targetAnchor = inferEdgeAnchor(
            targetPos,
            normalizedPoints[normalizedPoints.length - 1],
            normalizedPoints[normalizedPoints.length - 2]
          );

          result.edges.push({
            source: sourceId,
            target: targetId,
            color,
            kind,
            count,
            resolution,
            points: anchorEdgePolyline(
              normalizedPoints,
              sourcePos,
              targetPos,
              sourceAnchor,
              targetAnchor
            ),
            sourceAnchor,
            targetAnchor,
          });
        }
      }
    }
  }

  processNode(elkNode, 0, 0);

  if (import.meta.env.DEV) {
    useDebugStore.getState().addLog(
      `extractLayout: found=${totalEdgesFound}, withSections=${edgesWithSections}, withoutSections=${edgesWithoutSections}, result=${result.edges.length}`
    );
  }

  // If ELK didn't route edges (either it produced none, or routing was skipped
  // for a large view), generate straight-line fallback edges from the view edges.
  if (result.edges.length === 0 && viewEdges.length > 0) {
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog("ELK provided no routed edges, generating straight-line fallback edges");
    }

    // Helper to create fallback edge
    const createFallbackEdge = (
      source: string,
      target: string,
      color: string,
      kind: EdgeKind | null,
      count: number,
      resolution: Resolution | null
    ): LayoutEdge | null => {
      const sourcePos = result.nodes[source];
      const targetPos = result.nodes[target];
      if (!sourcePos || !targetPos) return null;

      const sourceCx = sourcePos.x + sourcePos.width / 2;
      const sourceCy = sourcePos.y + sourcePos.height / 2;
      const targetCx = targetPos.x + targetPos.width / 2;
      const targetCy = targetPos.y + targetPos.height / 2;

      const dx = targetCx - sourceCx;
      const dy = targetCy - sourceCy;

      let startPoint: Point;
      let endPoint: Point;

      if (Math.abs(dx) > Math.abs(dy)) {
        startPoint = {
          x: dx > 0 ? sourcePos.x + sourcePos.width : sourcePos.x,
          y: sourceCy,
        };
        endPoint = {
          x: dx > 0 ? targetPos.x : targetPos.x + targetPos.width,
          y: targetCy,
        };
      } else {
        startPoint = {
          x: sourceCx,
          y: dy > 0 ? sourcePos.y + sourcePos.height : sourcePos.y,
        };
        endPoint = {
          x: targetCx,
          y: dy > 0 ? targetPos.y : targetPos.y + targetPos.height,
        };
      }

      const sourceAnchor = inferEdgeAnchor(sourcePos, startPoint, endPoint);
      const targetAnchor = inferEdgeAnchor(targetPos, endPoint, startPoint);

      return {
        source,
        target,
        color,
        kind,
        count,
        resolution,
        points: anchorEdgePolyline(
          [startPoint, endPoint],
          sourcePos,
          targetPos,
          sourceAnchor,
          targetAnchor
        ),
        sourceAnchor,
        targetAnchor,
      };
    };

    // Generate straight-line fallback for every view edge whose endpoints are
    // present in the layout.
    for (const ve of viewEdges) {
      const fallbackEdge = createFallbackEdge(
        ve.source,
        ve.target,
        ve.color,
        ve.kind,
        ve.count,
        ve.resolution
      );
      if (fallbackEdge) {
        result.edges.push(fallbackEdge);
      }
    }

    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`Generated ${result.edges.length} fallback edges`);
    }
  }

  return result;
}

function fallbackLayout(
  graph: CodeGraph,
  visibleNodes: Set<string>,
  edgeKindCounts: EdgeKindCounts
): LayoutResult {
  const result: LayoutResult = { nodes: {}, edges: [], edgeKindCounts };
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
    result.nodes[nodeId] = {
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

  return result;
}
