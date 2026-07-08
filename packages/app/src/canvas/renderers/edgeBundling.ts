import type { CodeGraph } from "../../api/types";
import type { Point } from "../layout/edgeGeometry";
import type { EdgeDatum } from "./types";

/**
 * A bundled edge represents multiple individual edges between
 * nodes that share the same file-level ancestor pair.
 */
export interface BundledEdge {
  /** File (or top-level) ancestor of the source nodes */
  sourceContainer: string;
  /** File (or top-level) ancestor of the target nodes */
  targetContainer: string;
  /** Number of individual edges collapsed into this bundle */
  count: number;
  /** Representative routing points (from the first edge in the group) */
  representativePoints: Point[];
  /** Display colour (from the first edge in the group) */
  color: string;
}

/**
 * Find the File-level (or top-level) ancestor of a node by walking
 * up the parent map. If the node itself is a File or Directory,
 * return it directly.
 */
function findFileAncestor(
  nodeId: string,
  graph: CodeGraph,
  parentMap: Map<string, string>
): string {
  let current = nodeId;
  while (true) {
    const parent = parentMap.get(current);
    if (!parent) return current;
    const parentNode = graph.nodes[parent];
    if (!parentNode || parentNode.type === "Directory") return current;
    current = parent;
  }
}

/**
 * Bundle edges by their file-level ancestor pairs.
 *
 * For each edge, the source and target are mapped up to their
 * nearest File ancestor.  Edges that share the same
 * (ancestorSource, ancestorTarget) pair are grouped into a single
 * BundledEdge with a count.
 */
export function bundleEdges(
  edgeData: EdgeDatum[],
  graph: CodeGraph,
  parentMap: Map<string, string>
): BundledEdge[] {
  const groups = new Map<
    string,
    {
      sourceContainer: string;
      targetContainer: string;
      count: number;
      representativePoints: Point[];
      color: string;
    }
  >();

  for (const edge of edgeData) {
    const ancestorSource = findFileAncestor(edge.source, graph, parentMap);
    const ancestorTarget = findFileAncestor(edge.target, graph, parentMap);

    // Skip self-loops at the container level
    if (ancestorSource === ancestorTarget) continue;

    const key = `${ancestorSource}->${ancestorTarget}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, {
        sourceContainer: ancestorSource,
        targetContainer: ancestorTarget,
        count: 1,
        representativePoints: edge.originalPoints.map((p) => ({ ...p })),
        color: edge.color,
      });
    }
  }

  return Array.from(groups.values());
}
