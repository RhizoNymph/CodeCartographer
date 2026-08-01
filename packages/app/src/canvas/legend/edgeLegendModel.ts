import type { EdgeKind, SubGraph } from "../../api/types";
import type { ViewMode } from "../../stores/graphViewModel";

/**
 * Pure view model for the edge legend.
 *
 * This module deliberately has TYPE-ONLY imports: it is unit-tested directly
 * under `node --test`, whose type stripping cannot resolve extensionless runtime
 * imports between source modules. Presentation lookups that need runtime data
 * (edge colours) are resolved by the component, not here.
 */

/** Every edge kind, in the order the legend lists them. */
export const LEGEND_EDGE_KINDS: readonly EdgeKind[] = [
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
];

/**
 * The edge kinds the legend can offer in a given view. Module view is
 * import-only -- its effective edge kinds are forced to {Import} -- so it gets a
 * single Import row; symbol view, including focus mode, exposes every kind.
 */
export function legendEdgeKinds(viewMode: ViewMode): EdgeKind[] {
  return viewMode === "module" ? ["Import"] : [...LEGEND_EDGE_KINDS];
}

/**
 * Per-kind edge counts for the CURRENT VIEW.
 *
 * `null` means "unknown": that kind was not part of the `get_subgraph` request
 * that produced these counts, so the view holds no information about it. This is
 * deliberately distinct from `0` ("fetched, and the view genuinely has none") --
 * a toggled-off kind is never fetched, and rendering it as `0` would both lie and
 * make the row look inert.
 */
export type EdgeKindCounts = Record<EdgeKind, number | null>;

/** Counts before any layout has run: every kind unknown. */
export function unknownEdgeKindCounts(): EdgeKindCounts {
  const counts = {} as EdgeKindCounts;
  for (const kind of LEGEND_EDGE_KINDS) counts[kind] = null;
  return counts;
}

/**
 * Derive per-kind view counts from the `SubGraph` the layout pass already
 * fetched. Underlying-edge semantics: a direct edge is one edge (its `weight` is
 * observation frequency, not a multiplier), and an aggregated edge contributes
 * its collapsed `count`.
 *
 * `fetchedKinds` are the kinds that were passed to `get_subgraph`; every other
 * kind comes back `null` (unknown) rather than `0`.
 *
 * `hideAmbiguousEdges` mirrors the render path: ambiguous DIRECT edges are
 * dropped from the layout, so they must not be counted either. Aggregated edges
 * carry no single resolution and are rendered -- and counted -- regardless.
 *
 * Known limitation: the backend keys aggregated edges on (source, target) only
 * and labels each with the first kind it saw, so when more than one kind is
 * fetched an aggregated edge's whole count is attributed to that one kind. The
 * total across kinds stays correct; the split can be off wherever collapsed
 * containers mix kinds. A proper fix means keying the backend's agg_map on
 * (source, target, kind).
 */
export function deriveEdgeKindCounts(
  subgraph: SubGraph,
  fetchedKinds: Iterable<EdgeKind>,
  hideAmbiguousEdges = false
): EdgeKindCounts {
  const counts = unknownEdgeKindCounts();
  for (const kind of fetchedKinds) counts[kind] = 0;

  const bump = (kind: EdgeKind, by: number) => {
    counts[kind] = (counts[kind] ?? 0) + by;
  };

  for (const edge of subgraph.edges) {
    if (hideAmbiguousEdges && edge.resolution === "Ambiguous") continue;
    bump(edge.kind, 1);
  }
  for (const aggregated of subgraph.aggregated_edges) {
    bump(aggregated.kind, aggregated.count);
  }

  return counts;
}

/** Human-readable plural name for an edge kind, as shown in the legend. */
export function edgeKindLabel(kind: EdgeKind): string {
  switch (kind) {
    case "Import": return "Imports";
    case "FunctionCall": return "Function calls";
    case "MethodCall": return "Method calls";
    case "TypeReference": return "Type references";
    case "Inheritance": return "Inheritance";
    case "TraitImpl": return "Trait impls";
    case "VariableUsage": return "Variable usages";
  }
}

/** One rendered legend row. Display decisions are resolved here, not in JSX. */
export interface LegendRow {
  kind: EdgeKind;
  label: string;
  /** Underlying edges of this kind in the current view; null when unknown. */
  count: number | null;
  /** Whether this kind is currently contributing edges to the view. */
  enabled: boolean;
  /** Whether clicking the row toggles the kind. */
  interactive: boolean;
  /** Render the row at reduced opacity. */
  dimmed: boolean;
  /** Strike through the label (the kind is toggled off). */
  struck: boolean;
}

export interface LegendRowsInput {
  counts: EdgeKindCounts;
  enabledEdgeKinds: ReadonlySet<EdgeKind>;
  viewMode: ViewMode;
}

/**
 * Build the legend rows for a view.
 *
 * Module view shows a single, non-interactive Import row: its effective edge
 * kinds are forced to {Import} regardless of the saved toggles, so the row always
 * reads as active and clicking it would be a lie.
 *
 * Symbol view (including focus mode) shows every kind. A row is inert only when
 * the kind is enabled and the view provably has no edges of it -- a toggled-off
 * row stays clickable, otherwise there would be no way to turn the kind back on.
 */
export function buildLegendRows({
  counts,
  enabledEdgeKinds,
  viewMode,
}: LegendRowsInput): LegendRow[] {
  const forced = viewMode === "module";

  return legendEdgeKinds(viewMode).map((kind) => {
    const count = counts[kind] ?? null;
    const enabled = forced || enabledEdgeKinds.has(kind);
    const hasNoEdges = count === 0;

    return {
      kind,
      label: edgeKindLabel(kind),
      count,
      enabled,
      interactive: forced ? false : !enabled || !hasNoEdges,
      dimmed: !enabled || hasNoEdges,
      struck: !enabled,
    };
  });
}
