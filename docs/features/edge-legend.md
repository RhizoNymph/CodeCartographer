# Edge Legend

## Scope

The edge legend is a bottom-left canvas overlay that names every edge kind in the
current view, shows its colour and its edge count for that view, and IS the
edge-kind toggle UI (it replaced the toolbar's edge-kind toggle row).

### In scope
- One row per edge kind available in the current view: colour swatch (from
  `EDGE_COLORS`), human-readable plural name, and the number of underlying edges
  of that kind **in the current view**.
- Clicking an interactive row toggles that kind via `graphStore.toggleEdgeKind`
  (the same action the old toolbar buttons used), which bumps `layoutVersion`
  and triggers a relayout.
- Toggled-off rows render dimmed and struck through; rows whose kind provably has
  zero edges in the view render dimmed and inert.
- Module view shows only the Import row, non-interactive, with an accurate count.
- Symbol view (including focus mode) shows every kind.

### Not in scope
- The ambiguous-edges toggle, the hide-unconnected toggle, and the LOD settings
  panel — those stay in the toolbar.
- Whole-repo edge totals. Counts are strictly per-view; `graph.edgeCount` (the
  backend total) is only used to decide whether to render the legend at all.
- Edge counts drawn on the edges themselves (that is a separate concern).

## Data / Control Flow

```
Canvas -> PixiRenderer.updateGraph(graph, expanded, visible,
                                   layoutEdgeKinds, layoutHideAmbiguous)
  -> elkLayout.layoutGraph(...)
       enabledKinds = Array.from(layoutEdgeKinds)      // module -> ["Import"]
       sub = await getSubgraph(renderIds, enabledKinds)
       edgeKindCounts = deriveEdgeKindCounts(sub, enabledKinds, hideAmbiguous)
       -> returned on LayoutResult.edgeKindCounts
  -> PixiRenderer, AFTER its stale-request check:
       useEdgeLegendStore.getState().setCounts(layout.edgeKindCounts)

EdgeLegend (React):
  counts            <- edgeLegendStore
  enabledEdgeKinds  <- graphStore
  viewMode          <- graphStore
  rows = buildLegendRows({ counts, enabledEdgeKinds, viewMode })
  row click -> graphStore.toggleEdgeKind(kind) -> layoutVersion++ -> relayout
               -> new counts published
```

The counts come from the **same `SubGraph` payload the layout already fetched** —
there is no extra IPC call and no second source of truth. Counting rule: a direct
edge contributes 1 (its `weight` is observation frequency, not a multiplier); an
aggregated edge contributes its collapsed `count`.

### Known vs unknown counts

Only the *enabled* kinds are sent to `get_subgraph`, so the payload says nothing
about a kind the user has toggled off. `EdgeKindCounts` therefore maps each kind
to `number | null`, where `null` means "not fetched, unknown" and renders as `—`.
This is what keeps a toggled-off row clickable: it is dimmed and struck but not
inert, because otherwise there would be no way to turn the kind back on. Only an
*enabled* kind with a known count of `0` is inert.

## Files

- `packages/app/src/canvas/legend/edgeLegendModel.ts` — pure view model.
  Exports `LEGEND_EDGE_KINDS`, `legendEdgeKinds(viewMode)`, `EdgeKindCounts`,
  `unknownEdgeKindCounts()`, `deriveEdgeKindCounts(subgraph, fetchedKinds,
  hideAmbiguousEdges?)`, `edgeKindLabel(kind)`, `LegendRow`, and
  `buildLegendRows({ counts, enabledEdgeKinds, viewMode })`.
- `packages/app/src/canvas/legend/EdgeLegend.tsx` — the overlay component.
  Reads counts from `edgeLegendStore` and toggle state from `graphStore`;
  resolves each row's swatch colour from `EDGE_COLORS`.
- `packages/app/src/stores/edgeLegendStore.ts` — `useEdgeLegendStore` holding
  `{ counts, setCounts }`. Layout OUTPUT, deliberately separate from `graphStore`
  (which holds user state).
- `packages/app/src/canvas/layout/elkLayout.ts` — derives `edgeKindCounts` from
  the fetched `SubGraph` and returns it on `LayoutResult`.
- `packages/app/src/canvas/renderers/PixiRenderer.ts` — publishes the counts to
  the store after the stale-layout check.
- `packages/app/src/App.tsx` — mounts `EdgeLegend` inside a relatively-positioned
  wrapper around `Canvas`, so the overlay anchors to the canvas area rather than
  the whole workspace (it must not sit over the sidebar).
- `packages/app/tests/edgeLegend.test.ts` — count derivation, row logic,
  module-view filtering.

## Invariants and Constraints

- **Counts are per-view, never whole-graph.** They are derived from the
  `SubGraph` returned for the current render set, so collapsing a container or
  entering focus changes them.
- **`null` is not `0`.** `null` = kind not fetched (unknown); `0` = fetched and
  genuinely empty. Only the latter makes a row inert.
- **A toggled-off row is always clickable.** Otherwise the kind could never be
  re-enabled.
- **Module view rows are non-interactive.** Module view forces effective edge
  kinds to `{Import}` regardless of the saved toggles, so the Import row always
  reads as active and clicking it would be a lie. The saved toggle state is
  preserved and untouched.
- **Counts respect the ambiguous filter.** `deriveEdgeKindCounts` skips ambiguous
  *direct* edges when `hideAmbiguousEdges` is on, mirroring the render path.
  Aggregated edges carry no single resolution and are counted regardless — again
  mirroring rendering.
- **Counts are published only for a current layout.** `PixiRenderer` calls
  `setCounts` after its `requestId` staleness check, so a superseded in-flight
  layout cannot clobber fresher counts.
- **The pure model has type-only imports.** `edgeLegendModel.ts` is unit-tested
  directly under `node --test`, whose type stripping cannot resolve extensionless
  runtime imports between source modules. It therefore defines its own kind order
  and leaves colour lookup to the component. Do not add a value import to it.
- **The overlay must not block the canvas.** The panel sizes to its content and
  is the only element with pointer events; there is no full-size wrapper.

## Known limitation (backend)

`SubGraph::from_graph` keys `aggregated_edges` on `(source, target)` **without**
the kind, labelling each aggregated edge with the first kind it saw and summing
`count` across kinds. So when more than one kind is fetched, an aggregated edge's
whole count is attributed to a single kind. The total across kinds stays correct,
but the per-kind split can be off wherever collapsed containers mix kinds. Module
view is unaffected (only `Import` is ever fetched), as is any symbol view with a
single kind enabled.

For the same reason the frontend must NOT "fetch all kinds once and filter by
kind client-side": aggregated edges are not decomposable by kind after the fact,
and `direct_pairs` suppression is computed from the enabled set, so the result
would differ from a narrower request. Fixing this properly means keying the
backend's `agg_map` on `(source, target, kind)`.
