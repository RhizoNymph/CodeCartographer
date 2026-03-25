import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import type { CodeGraph, CodeNode, CodeEdge, EdgeKind } from "../../api/types";
import { EDGE_COLORS } from "../../api/types";
import { useDebugStore } from "../../stores/debugStore";
import {
  anchorEdgePolyline,
  dedupePolylinePoints,
  inferEdgeAnchor,
  type EdgeAnchor,
  type Point,
} from "./edgeGeometry";
import { buildParentMap, getNodeSize } from "../utils/graphUtils";

const elk = new ELK();

/**
 * Find the visible ancestor of a node. If the node is in elkNodeIds, return itself.
 * Otherwise, walk up the parent chain until we find a node in elkNodeIds.
 * Returns null if no visible ancestor found (shouldn't happen for valid graphs).
 */
function findVisibleAncestor(
  nodeId: string,
  elkNodeIds: Set<string>,
  parentMap: Map<string, string>
): string | null {
  let current = nodeId;
  while (current) {
    if (elkNodeIds.has(current)) {
      return current;
    }
    const parent = parentMap.get(current);
    if (!parent) {
      return null;
    }
    current = parent;
  }
  return null;
}

/**
 * Compute aggregated edges for collapsed containers.
 * When a container is collapsed, edges to/from its children should be
 * shown as a single edge to/from the container itself.
 */
function computeAggregatedEdges(
  graph: CodeGraph,
  elkNodeIds: Set<string>,
  parentMap: Map<string, string>,
  enabledEdgeKinds?: Set<EdgeKind>
): Array<{ source: string; target: string; color: string; kind: EdgeKind | null }> {
  // Use a Map to deduplicate edges by source-target pair
  // Key: "source->target", Value: { color, kind } (we pick one, could aggregate later)
  const aggregatedMap = new Map<string, { color: string; kind: EdgeKind }>();

  // Filter edges by enabled kinds
  const filteredEdges = enabledEdgeKinds
    ? graph.edges.filter((e) => enabledEdgeKinds.has(e.kind))
    : graph.edges;

  for (const edge of filteredEdges) {
    const sourceInTree = elkNodeIds.has(edge.source);
    const targetInTree = elkNodeIds.has(edge.target);

    // Skip edges that are already fully in the tree - they're handled normally
    if (sourceInTree && targetInTree) {
      continue;
    }

    // Find visible ancestors for both endpoints
    const visibleSource = findVisibleAncestor(edge.source, elkNodeIds, parentMap);
    const visibleTarget = findVisibleAncestor(edge.target, elkNodeIds, parentMap);

    // Skip if we can't find visible ancestors (both hidden or disconnected)
    if (!visibleSource || !visibleTarget) {
      continue;
    }

    // Skip self-loops (both endpoints resolve to same collapsed container)
    if (visibleSource === visibleTarget) {
      continue;
    }

    // Create aggregated edge key and store
    const key = `${visibleSource}->${visibleTarget}`;
    if (!aggregatedMap.has(key)) {
      aggregatedMap.set(key, { color: EDGE_COLORS[edge.kind] || "#64748b", kind: edge.kind });
    }
  }

  // Convert to array
  const result: Array<{ source: string; target: string; color: string; kind: EdgeKind | null }> = [];
  for (const [key, { color, kind }] of aggregatedMap) {
    const [source, target] = key.split("->");
    result.push({ source, target, color, kind });
  }

  return result;
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
  kind: EdgeKind | null; // null for aggregated edges
  points: Point[];
  sourceAnchor: EdgeAnchor;
  targetAnchor: EdgeAnchor;
}

export interface LayoutResult {
  nodes: Record<string, LayoutNodePosition>;
  edges: LayoutEdge[];
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
  enabledEdgeKinds?: Set<EdgeKind>
): Promise<LayoutResult> {
  const rootNode = graph.nodes[graph.root];
  if (!rootNode) {
    return { nodes: {}, edges: [] };
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

  // Collect all node IDs that are actually in the ELK tree
  const elkNodeIds = new Set<string>();
  function collectElkNodeIds(nodes: ElkNode[]) {
    for (const n of nodes) {
      elkNodeIds.add(n.id);
      if (n.children) collectElkNodeIds(n.children);
    }
  }
  collectElkNodeIds(children);

  // Build parent map for finding visible ancestors
  const parentMap = buildParentMap(graph);

  // Filter edges by enabled edge kinds first
  const kindFilteredEdges = enabledEdgeKinds
    ? graph.edges.filter((e) => enabledEdgeKinds.has(e.kind))
    : graph.edges;

  // Build edges - only include edges where both endpoints are in the ELK tree
  const edgesInTree = kindFilteredEdges.filter(
    (e) => elkNodeIds.has(e.source) && elkNodeIds.has(e.target)
  );
  const edgesNotInTree = kindFilteredEdges.filter(
    (e) => !elkNodeIds.has(e.source) || !elkNodeIds.has(e.target)
  );

  // Compute aggregated edges for collapsed containers
  const aggregatedEdges = computeAggregatedEdges(graph, elkNodeIds, parentMap, enabledEdgeKinds);

  if (import.meta.env.DEV) {
    useDebugStore.getState().addLog(
      `Edge filtering: total=${graph.edges.length}, inTree=${edgesInTree.length}, missing=${edgesNotInTree.length}, aggregated=${aggregatedEdges.length}`
    );
  }

  // Create ELK edges from direct edges
  const elkEdges: ElkExtendedEdge[] = edgesInTree.map((e, i) => ({
    id: `edge-${i}`,
    sources: [e.source],
    targets: [e.target],
  }));

  // Add aggregated edges for collapsed containers
  for (let i = 0; i < aggregatedEdges.length; i++) {
    const ae = aggregatedEdges[i];
    elkEdges.push({
      id: `agg-edge-${i}`,
      sources: [ae.source],
      targets: [ae.target],
    });
  }

  const elkGraph: ElkNode = {
    id: "root",
    children,
    edges: elkEdges,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "20",
      "elk.spacing.edgeNode": "15",
      "elk.layered.spacing.nodeNodeBetweenLayers": "30",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.padding": "[top=30,left=15,bottom=15,right=15]",
    },
  };

  if (import.meta.env.DEV) {
    const codeBlocksInGraph = Object.values(graph.nodes).filter(n => n.type === "CodeBlock").length;
    useDebugStore.getState().addLog(
      `ELK: codeBlocks=${codeBlocksInGraph}, edges=${graph.edges.length}, aggregated=${aggregatedEdges.length}, elkNodes=${elkNodeIds.size}`
    );
  }

  // Build aggregated edge info map for extractLayout
  const aggregatedEdgeInfo = new Map<string, { color: string; kind: EdgeKind | null }>();
  for (const ae of aggregatedEdges) {
    aggregatedEdgeInfo.set(`${ae.source}->${ae.target}`, { color: ae.color, kind: ae.kind });
  }

  try {
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`ELK layout starting...`);
    }
    const laidOut = await elk.layout(elkGraph);
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`ELK layout done, extracting...`);
    }
    const result = extractLayout(laidOut, graph, aggregatedEdgeInfo);
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog(`ELK extracted ${result.edges.length} edges`);

      // Update debug store
      const codeBlocksInGraph = Object.values(graph.nodes).filter(n => n.type === "CodeBlock").length;
      const filesWithChildren = Object.values(graph.nodes).filter(n => n.type === "File" && n.children.length > 0).length;
      const expandedFiles = Array.from(expandedNodes).filter(id => graph.nodes[id]?.type === "File").length;
      useDebugStore.getState().setLayoutInfo({
        elkNodeIds: elkNodeIds.size,
        edgesInTree: edgesInTree.length,
        edgesNotInTree: edgesNotInTree.length,
        aggregatedEdges: aggregatedEdges.length,
        elkEdgesInput: elkEdges.length,
        elkEdgesOutput: result.edges.length,
        edgesWithSections: result.edges.length, // approximate
        edgesWithoutSections: elkEdges.length - result.edges.length,
        sampleGraphEdge: JSON.stringify(graph.edges[0]),
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
    return fallbackLayout(graph, visibleNodes);
  }
}

function extractLayout(
  elkNode: ElkNode,
  graph: CodeGraph,
  aggregatedEdgeInfo: Map<string, { color: string; kind: EdgeKind | null }>
): LayoutResult {
  const result: LayoutResult = { nodes: {}, edges: [] };

  const edgeLookup = new Map<string, CodeEdge>();
  for (const e of graph.edges) {
    const key = `${e.source}->${e.target}`;
    if (!edgeLookup.has(key)) edgeLookup.set(key, e);
  }

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

        // Check if this is an aggregated edge first, then fall back to graph edges
        const aggKey = `${sourceId}->${targetId}`;
        const aggInfo = aggregatedEdgeInfo.get(aggKey);

        let color: string;
        let kind: EdgeKind | null;
        if (aggInfo) {
          color = aggInfo.color;
          kind = aggInfo.kind;
        } else {
          const graphEdge = edgeLookup.get(`${sourceId}->${targetId}`);
          color = graphEdge
            ? EDGE_COLORS[graphEdge.kind]
            : "#64748b";
          kind = graphEdge?.kind ?? null;
        }

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

  // If ELK didn't provide edges, generate straight-line fallback edges from graph data
  if (result.edges.length === 0 && graph.edges.length > 0) {
    if (import.meta.env.DEV) {
      useDebugStore.getState().addLog("ELK provided no routed edges, generating fallback edges from graph");
    }

    // Helper to create fallback edge
    const createFallbackEdge = (
      source: string,
      target: string,
      color: string,
      kind: EdgeKind | null
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

    // Generate fallback for direct edges (where both endpoints are visible)
    for (const edge of graph.edges) {
      const fallbackEdge = createFallbackEdge(
        edge.source,
        edge.target,
        EDGE_COLORS[edge.kind] || "#64748b",
        edge.kind
      );
      if (fallbackEdge) {
        result.edges.push(fallbackEdge);
      }
    }

    // Generate fallback for aggregated edges
    for (const [key, info] of aggregatedEdgeInfo) {
      const [source, target] = key.split("->");
      const fallbackEdge = createFallbackEdge(source, target, info.color, info.kind);
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
  visibleNodes: Set<string>
): LayoutResult {
  const result: LayoutResult = { nodes: {}, edges: [] };
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
