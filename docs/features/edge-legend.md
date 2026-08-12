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
  (the same action the old toolbar buttons used), which bumps `edgeVersion` and
  runs the cheap EDGE phase only -- the node positions stay put (see
  graph-layout.md). The one exception is `hideUnconnectedNodes`, which makes the
  node set depend on the enabled kinds and therefore forces a full layout.
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
Canvas -> PixiRenderer.updateGraph(...)   // full layout  (layoutVersion)
       -> PixiRenderer.updateEdges(layoutEdgeKinds, layoutHideAmbiguous)
                                          // edges only   (edgeVersion)
  -> both phases go through layout/viewEdges.fetchViewEdges:
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
  row click -> graphStore.toggleEdgeKind(kind) -> edgeVersion++ -> edge phase
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

## Palette interaction (shared hues)

`EDGE_COLORS` is built from five `EDGE_HUES` covering seven kinds
(see docs/features/palette.md): `FunctionCall` + `MethodCall` share the *calls*
hue, and `Inheritance` + `TraitImpl` share the *subtype* hue. The legend keeps
one row per KIND — matching palette rule 2, which merges only the colour and
keeps the kinds distinct in the toggles — and each swatch shows that kind's real
`EDGE_COLORS` value. Two pairs of rows therefore render identical swatches, and
those rows sit adjacent in `LEGEND_EDGE_KINDS` order.

This is deliberate. The legend's job is to let a user map an edge colour seen on
the canvas back to a meaning; giving the paired kinds distinct swatch treatments
would imply a visual distinction the canvas does not draw and would break that
mapping. Two green rows correctly say "green means a call, either function or
method", and the row labels plus per-row counts carry the rest. Because the
swatch reads `EDGE_COLORS[row.kind]` at render time, the legend tracks any future
palette change automatically.

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

## Per-kind aggregation (backend)

`SubGraph::from_graph` keys `aggregated_edges` on `(source, target, kind)` --
one aggregate per kind and pair -- so the legend's per-kind counts over
aggregated edges are exact in every view. (Before this, aggregates were keyed on
the pair alone, labelled with the first kind seen, and summed counts across
kinds, making the split approximate whenever collapsed containers mixed kinds.)

The frontend still fetches only the enabled kinds rather than fetching all kinds
and filtering client-side -- per-kind keying makes the result decomposable by
kind, but narrower requests keep the payload proportional to what is actually
rendered.
