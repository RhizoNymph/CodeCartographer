/**
 * ELK edge ids encode the index of the view edge they were built from
 * (`edge-<index into viewEdges>`). Resolving a routed edge back through this
 * index -- instead of a `source->target` pair map -- keeps parallel edges
 * between the same node pair (different kinds after per-kind aggregation)
 * styled from their own kind/color/count rather than whichever edge happened
 * to be first.
 *
 * Kept import-free so it stays loadable under `node --test` type stripping.
 */

const ELK_EDGE_ID_PATTERN = /^edge-(\d+)$/;

/** Build the ELK edge id for the view edge at `index`. */
export function elkEdgeId(index: number): string {
  return `edge-${index}`;
}

/**
 * Parse an ELK edge id back to its view-edge index, or null when the id is not
 * one this module produced.
 */
export function elkEdgeIndex(id: string): number | null {
  const match = ELK_EDGE_ID_PATTERN.exec(id);
  if (!match) return null;
  return Number(match[1]);
}
