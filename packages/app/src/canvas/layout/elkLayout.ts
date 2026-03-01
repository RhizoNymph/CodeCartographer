import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import type { CodeGraph, CodeNode } from "../../api/types";
import { EDGE_COLORS } from "../../api/types";

const elk = new ELK();

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
  points: Array<{ x: number; y: number }>;
}

export interface LayoutResult {
  nodes: Record<string, LayoutNodePosition>;
  edges: LayoutEdge[];
}

function getNodeSize(node: CodeNode): { width: number; height: number } {
  switch (node.type) {
    case "Directory":
      return { width: 200, height: 60 };
    case "File":
      return { width: 180, height: 40 };
    case "CodeBlock":
      return { width: 160, height: 32 };
  }
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
  visibleNodes: Set<string>
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

  // Build edges
  const elkEdges: ElkExtendedEdge[] = graph.edges
    .filter(
      (e) => visibleNodes.has(e.source) && visibleNodes.has(e.target)
    )
    .map((e, i) => ({
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
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "30",
      "elk.spacing.edgeNode": "20",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.padding": "[top=40,left=20,bottom=20,right=20]",
    },
  };

  try {
    const laidOut = await elk.layout(elkGraph);
    return extractLayout(laidOut, graph);
  } catch (err) {
    console.error("ELK layout failed:", err);
    return fallbackLayout(graph, visibleNodes);
  }
}

function extractLayout(elkNode: ElkNode, graph: CodeGraph): LayoutResult {
  const result: LayoutResult = { nodes: {}, edges: [] };

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
      for (const edge of node.edges) {
        const sourceId = edge.sources[0];
        const targetId = edge.targets[0];
        const graphEdge = graph.edges.find(
          (e) => e.source === sourceId && e.target === targetId
        );
        const color = graphEdge
          ? EDGE_COLORS[graphEdge.kind]
          : "#64748b";

        const points: Array<{ x: number; y: number }> = [];
        if (edge.sections) {
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
        }

        if (points.length >= 2) {
          result.edges.push({ source: sourceId, target: targetId, color, points });
        }
      }
    }
  }

  processNode(elkNode, 0, 0);
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
