import type { CodeGraph } from "../api/types";

/**
 * Single O(n) pass to find all node IDs matching a search query,
 * plus their ancestors (so the tree can show the path to matches).
 *
 * Returns all node IDs when the query is empty/whitespace.
 * Returns an empty set when no nodes match.
 */
export function computeMatchingNodeIds(
    graph: CodeGraph,
    query: string
): Set<string> {
    if (!query.trim()) {
        return new Set(Object.keys(graph.nodes));
    }

    const lowerQuery = query.toLowerCase();
    const matchingIds = new Set<string>();

    // Build parent map in a single pass
    const parentMap = new Map<string, string>();
    for (const [id, node] of Object.entries(graph.nodes)) {
        for (const childId of node.children) {
            parentMap.set(childId, id);
        }
    }

    // Find direct matches, then walk up to include ancestors
    for (const [id, node] of Object.entries(graph.nodes)) {
        if (node.name.toLowerCase().includes(lowerQuery)) {
            matchingIds.add(id);
            let current = parentMap.get(id);
            while (current) {
                if (matchingIds.has(current)) break; // ancestor already added
                matchingIds.add(current);
                current = parentMap.get(current);
            }
        }
    }

    return matchingIds;
}

/**
 * Returns ONLY directly matching node IDs (not ancestors), sorted in
 * tree-traversal (depth-first) order. Used for prev/next navigation.
 */
export function computeDirectMatchIds(
    graph: CodeGraph,
    query: string
): string[] {
    if (!query.trim()) return [];

    const lowerQuery = query.toLowerCase();

    // Collect direct matches
    const directMatches = new Set<string>();
    for (const [id, node] of Object.entries(graph.nodes)) {
        if (node.name.toLowerCase().includes(lowerQuery)) {
            directMatches.add(id);
        }
    }

    if (directMatches.size === 0) return [];

    // Sort in tree-traversal (depth-first) order
    const ordered: string[] = [];
    const traverse = (nodeId: string) => {
        if (directMatches.has(nodeId)) {
            ordered.push(nodeId);
        }
        const node = graph.nodes[nodeId];
        if (node) {
            for (const childId of node.children) {
                traverse(childId);
            }
        }
    };
    traverse(graph.root);

    return ordered;
}
