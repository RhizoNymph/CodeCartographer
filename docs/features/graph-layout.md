# Graph Layout

## Scope

Turning the current view state into positioned nodes and drawn edges, and
deciding **how much of that work a given user action actually costs**.

The pipeline has two phases and one trigger policy:

- **Positions phase** (`elkLayout.layoutGraph`) — build the ELK containment tree
  for the render set, fetch that set's view edges, and let ELK (in its web
  worker) solve node placement + orthogonal edge routing. The only phase that
  produces node positions, and the expensive one.
- **Edges phase** (`edgePhase.layoutEdgePhase`) — re-fetch/re-filter the view
  edges for the SAME render set and rebuild them against the cached node
  positions. No ELK run, no node churn, no viewport refit.
- **Trigger policy** (`stores/relayoutPolicy.ts`) — a dependency-free pure module
  answering "given this state change, does the canvas need a full layout, an
  edge phase, the cheap visibility path, or nothing?".

### In scope
- The ELK graph construction, the render set (`renderIds`), edge routing,
  extraction, and the straight-line fallbacks.
- The layout-time edge-routing guard (when ELK routing is skipped in favour of
  straight-line fallback edges) and the whole-layout fallback used when ELK
  throws.
- The per-view `get_subgraph` fetch and its derived `edgeKindCounts`.
- Coalescing concurrent layout requests and discarding stale results.
- The relayout trigger policy and the store's trigger counters.

- Deciding each edge's endpoint anchors, once, from the pristine route (see
  "The anchor contract").

### Not in scope
- What the edges *look like* once positioned: the draw-time route pipeline
  (`layout/edgeRoutePipeline.ts`, which lives under `layout/` because it is
  geometry, but is documented in canvas-rendering) and its budget.
- Which nodes are visible/expanded in the first place (see zoom-views,
  visibilityFilter).
- Server-side subgraph/aggregation semantics (see server_side_graph_state).

## Trigger policy

`layoutWorkFor(change, ctx) -> "full" | "edges" | "visibility" | "none"`, then
`applyLayoutWork(work, triggers)` folds the answer into the store's counters.
**At most one counter is bumped per user action**, so one action can never cost
two layouts (the old `needsRelayout` + `layoutVersion` double-layout is gone).

| Action | Module view | Symbol view | While focused | Work performed |
| --- | --- | --- | --- | --- |
| New graph parsed (`setGraph`) | full | full | full | ELK + `get_subgraph` |
| Expand/collapse a Directory | full | full | none | ELK + `get_subgraph` |
| Expand/collapse a File / CodeBlock | none | full | none | ELK + `get_subgraph` |
| Sidebar checkbox: hide a node | visibility | visibility | none | flip node displays + edge redraw |
| Sidebar checkbox: show a node | full | full | none | ELK + `get_subgraph` |
| Toggle an edge kind (legend row) | none | edges (full if hide-unconnected is on) | edges | `get_subgraph` + edge rebuild |
| Toggle hide-ambiguous | none | edges | edges | `get_subgraph` + edge rebuild |
| Toggle hide-unconnected | full | full | none | ELK + `get_subgraph` |
| Switch Module/Symbol view | full | full | full | ELK + `get_subgraph` |
| Enter/pop/clear focus, change depth/direction | full | full | full | frame fetch + ELK + `get_subgraph` |
| "Apply Layout Changes" button | full | full | full | ELK + `get_subgraph` |
| Hover, select, drag, zoom/LOD | none | none | none | local redraws only |

Reasoning behind the non-obvious rows:

- **Showing vs hiding nodes.** Hiding can only remove nodes that already have
  positions, so the canvas just flips `container.visible`. Showing can reveal a
  node that was never laid out, which needs real positions.
- **Edge-kind toggles.** They change which edges are fetched, not where nodes
  are — *unless* `hideUnconnectedNodes` is on, which makes the node set itself a
  function of the enabled kinds and therefore a full layout.
- **Module view.** Edge kinds are forced to `{Import}` and files are treated as
  collapsed, so kind/ambiguity/file-expansion changes cannot affect that view.
- **Focus.** A focused view derives both its visible and expanded sets from the
  fetched frame payload, so expansion/visibility/hide-unconnected toggles are
  inert until focus is left.

`needsRelayout` is now only a **hint**: it is set when a cheaper path kept the
existing positions (edges or visibility work), and it drives the sidebar's
"Apply Layout Changes" button. It never triggers a layout by itself.

## Data / Control Flow

```
graphStore action
  -> layoutTriggers(state, change)                     [stores/relayoutPolicy]
       layoutWorkFor(change, {viewMode, focusActive, hideUnconnectedNodes})
       applyLayoutWork(work, {layoutVersion, edgeVersion, needsRelayout})
  -> exactly one of: layoutVersion++ | edgeVersion++ | needsRelayout only | nothing

Canvas.tsx
  layoutInputsRef       <- latest derived inputs (new Set identities each render,
                           so the layout effects must NOT depend on them)
  [graph, layoutVersion] -> PixiRenderer.updateGraph(graph, layoutExpanded,
                              displayVisible, layoutEdgeKinds, layoutHideAmbig)
  [edgeVersion]          -> PixiRenderer.updateEdges(layoutEdgeKinds,
                              layoutHideAmbig)
  [displayVisibleNodes]  -> PixiRenderer.updateVisibility(displayVisible)
                            (skipped when a layout request just took that set)

PixiRenderer.layoutQueue  (CoalescingScheduler<LayoutRequest>)
  schedule(full|edges) -> runs immediately when idle;
                          otherwise merged into ONE pending rerun
                          (mergeLayoutRequests: full dominates edges,
                           adopting the newest edge filters)
  run:
    full  -> layoutGraph(...)      -> LayoutResult{nodes, edges, counts, renderIds}
             -> renderFromLayout   (rebuild node displays, edges, refit viewport)
    edges -> layoutEdgePhase(lastLayout, kinds, hideAmbiguous)
             -> rebuildEdgeDisplays (edges only; viewport untouched)
  both: `_layoutRequestId` guards the result, and edgeKindCounts are published to
        edgeLegendStore only after that guard.

elkLayout.layoutGraph
  buildElkNode tree from (visible ∩ expanded-ancestors)  -> renderIds
  fetchViewEdges(renderIds, kinds, hideAmbiguous)        [layout/viewEdges.ts]
    -> get_subgraph -> direct + aggregated ViewEdges, deriveEdgeKindCounts
  ELK layered layout (routing skipped above the node/edge limits, see
    "Routing guard" below)
  extractLayout -> positions + routed polylines (straightLineEdges as fallback)

edgePhase.layoutEdgePhase(previous, kinds, hideAmbiguous)
  fetchViewEdges(previous.renderIds, ...)   // same render set, new filters
  rebuildEdges: reuse the previous routed polyline for any edge with the same
    (source, target, kind); straight-line connector for edges appearing anew
  -> LayoutResult with previous.nodes and previous.renderIds unchanged
```

### Positions phase in detail

1. `buildElkNode` walks the node tree from the graph root, emitting an `ElkNode`
   per visible node. An expanded node with visible children gets `children` +
   container padding and lets ELK size it; otherwise it carries `getNodeSize`'s
   width/height.
2. `collectElkNodeIds` collects the resulting render set (`elkNodeIds`) -- the
   ids actually laid out, i.e. visible nodes whose ancestors are all expanded.
3. `fetchViewEdges(renderIds, enabledKinds)` (`get_subgraph` over Tauri IPC)
   returns the view's direct edges (each with a `Resolution`) and aggregated
   edges (each with a `count`). These become `ViewEdge[]`; ambiguous direct
   edges are dropped here when the toolbar toggle asks for it. The same payload
   derives the legend's per-kind counts (`deriveEdgeKindCounts`).
4. **Routing guard.** `shouldSkipLayoutEdgeRouting(elkNodeIds.size, viewEdges.length)`
   (from `layout/edgeRoutingBudget.ts`) decides whether ELK is given any edges
   at all. Routing cost is driven by EDGES as much as by nodes, so BOTH counts
   gate it:
   - `LAYOUT_EDGE_ROUTING_NODE_LIMIT` = 1500 rendered nodes
   - `LAYOUT_EDGE_ROUTING_EDGE_LIMIT` = 3000 view edges

   Over either limit, `elkEdges` is empty: ELK positions nodes only, and
   `extractLayout` synthesises straight-line fallback edges instead.
5. Each ELK edge id encodes its `viewEdges` INDEX (`elkEdgeId` / `elkEdgeIndex`),
   so extraction maps a routed edge back to exactly the view edge it came from --
   parallel same-pair edges (one aggregate per kind) keep their own
   kind/colour/count.
6. `elk.layout(elkGraph)` runs in a web worker (`elkjs/lib/elk-api` +
   `elk-worker.min.js?worker`), so layout never blocks the UI thread.
7. `extractLayout` is composition only; the work lives in the pure, ELK-free
   `layout/elkExtract.ts`:
   - `extractNodePositions(root)` walks the tree once, accumulating parent
     offsets into absolute positions (root excluded).
   - `extractRoutedEdges(root, positions, viewEdges)` walks it again — an edge's
     section coordinates are relative to the node it hangs off, so the walk has
     to carry that node's offset — and turns each ELK edge into a `LayoutEdge`
     via `routedEdgeFromElk`, returning the counts the DEV debug line reports.
   - `routedEdgeFromElk` is where an edge's ANCHORS ARE DECIDED, exactly once
     (see "The anchor contract" below), before `anchorEdgePolyline` makes the
     geometry agree with them.

   If no routed edges came back (ELK produced none, or routing was skipped) it
   emits a straight-line edge per view edge whose endpoints are present.
8. If `elk.layout` throws, `fallbackLayout` lays the visible nodes out on a plain
   grid with no edges, so the canvas still renders something.

### The anchor contract

An edge's endpoint anchor (`{side, offset}` into a node box) is decided **once,
at layout time, from pristine geometry** and then carried as a durable field on
`LayoutEdge` and `EdgeDatum`. Nothing downstream re-derives it from a polyline.

- **Who decides.** `elkExtract.routedEdgeFromElk` for ELK-routed edges (via
  `edgeGeometry.edgeAnchorAtBoundary`), and `straightEdges.straightLineEdge` for
  fallback connectors — the latter CHOOSES the facing sides, so it states the
  anchors outright instead of reading them back.
- **How exactly.** `edgeAnchorAtBoundary` reads the side off the first (or last)
  segment's DIRECTION: an orthogonal edge can only leave a box through the side
  its first segment points at. Two ordered fallbacks handle non-orthogonal input
  — the side the point demonstrably sits on, then the dominant axis of the
  departure — and exist for the centre-to-centre connector ELK leaves when it
  routes nothing. There is no "which side did the router probably mean" guess
  from how near a bend happens to be to a box edge.
- **Who consumes.** `edgeRebuild` (cached edges keep their anchors), and every
  draw-time stage in `layout/edgeRoutePipeline.ts`, which derives endpoints from
  `(box, anchor)` through `getAnchorPoint` (see canvas-rendering).
- **When a NEW anchor may be decided.** Only when a node has been dragged away
  from its laid-out position: the stored anchor describes geometry that no
  longer exists, so the pipeline picks a fresh one facing the opposite endpoint
  (`inferEdgeAnchorFromPoint`). That is a new decision, not a re-derivation.

`anchorEdgePolyline` makes the decision it used to hide explicit: it returns
`{ points, rerouted }`, where `rerouted: true` means the incoming route was
DISCARDED and replaced by `rerouteOrthogonalEdge` rather than nudged onto its
anchors.

### Why the edges phase reuses routed geometry

ELK's `layered` algorithm places nodes *from* the edge set, so re-running it for a
filter change both costs a full solve and makes the whole graph jump. Keeping the
positions is the better trade: filtering **down** (turning a kind off, hiding
ambiguous edges) is then visually lossless, since every surviving edge keeps the
polyline ELK routed for it. Edges that appear for the first time (turning a kind
back on) get a straight connector until the next full layout — the sidebar's
"Apply Layout Changes" button re-routes everything on demand.

## Files

- `packages/app/src/stores/relayoutPolicy.ts` — PURE trigger policy:
  `LayoutWork`, `GraphChange`, `LayoutContext`, `layoutWorkFor`,
  `applyLayoutWork`, `marksLayoutStale`. Type-only imports; unit-tested.
- `packages/app/src/stores/graphStore.ts` — `layoutTriggers(state, change)` is
  the single place actions consult the policy; holds `layoutVersion`,
  `edgeVersion`, `needsRelayout`.
- `packages/app/src/canvas/Canvas.tsx` — derives the effective layout inputs,
  keeps them in a ref, and runs one effect per trigger counter.
- `packages/app/src/canvas/layout/elkLayout.ts` — positions phase
  (`layoutGraph`), ELK options, the routing guard call, the `extractLayout`
  composition + DEV logging (`debugLog`), ELK-failure fallback layout.
- `packages/app/src/canvas/layout/elkExtract.ts` — the PURE half of extraction:
  `extractNodePositions`, `elkEdgePolyline`, `routedEdgeFromElk`,
  `extractRoutedEdges` (+ `ExtractStats`). ELK types are imported type-only and
  runtime imports use `.ts` specifiers, so it is testable without the worker.
- `packages/app/src/canvas/layout/edgePhase.ts` — edges phase
  (`layoutEdgePhase`; re-exports `rebuildEdges`).
- `packages/app/src/canvas/layout/edgeRebuild.ts` — the pure core of the edges
  phase (`rebuildEdges`): routed-polyline reuse + straight-line fallback.
  Loadable under node:test via explicit `.ts` runtime specifiers (its
  `straightEdges` -> `edgeGeometry` chain likewise); seam-tested against the
  drawing pass's anchored-polyline contract.
- `packages/app/src/canvas/layout/viewEdges.ts` — `fetchViewEdges` (the
  `get_subgraph` call), `ViewEdge`, `ALL_EDGE_KINDS`; shared by both phases.
- `packages/app/src/canvas/layout/straightEdges.ts` — `straightLineEdge(s)`
  fallback geometry.
- `packages/app/src/canvas/layout/layoutTypes.ts` — `LayoutNodePosition`,
  `LayoutEdge`, `LayoutResult` (incl. `renderIds`, `edgeKindCounts`).
- `packages/app/src/canvas/layout/layoutRequest.ts` — `LayoutRequest` union and
  `mergeLayoutRequests`; PURE, unit-tested.
- `packages/app/src/canvas/layout/layoutScheduler.ts` — `CoalescingScheduler`,
  the generic run-latest queue; PURE, unit-tested.
- `packages/app/src/canvas/layout/elkEdgeId.ts` — encodes/decodes the viewEdges
  index in an ELK edge id (`elkEdgeId`, `elkEdgeIndex`).
- `packages/app/src/canvas/layout/edgeGeometry.ts` — orthogonal polyline
  geometry: anchors, normalisation, obstacle detours (`edgeAnchorAtBoundary`,
  `anchorOnSide`, `getAnchorPoint`, `anchorEdgePolyline` -> `AnchoredPolyline`,
  `normalizeRoutedPolyline`, `ensureDrawablePolyline`,
  `routePolylineAroundObstacles`, `boundingBox`, `pointToPolylineDistance`).
- `packages/app/src/canvas/layout/edgeRoutePipeline.ts` — the DRAW-time route
  pipeline (see canvas-rendering); lives here because it is geometry, not
  rendering, and because it must stay loadable under `node --test`.
- `packages/app/src/canvas/layout/routingConstants.ts` — every routing tolerance
  and margin in one dependency-free module, with derived values expressed as
  arithmetic (`OBSTACLE_QUERY_MARGIN` = `NODE_OBSTACLE_MARGIN` + `DETOUR_GUTTER`
  + `OBSTACLE_QUERY_ALLOWANCE`).
- `packages/app/src/canvas/layout/edgeRoutingBudget.ts` — ALL routing
  thresholds, layout-time and draw-time (`shouldSkipLayoutEdgeRouting`,
  `LAYOUT_EDGE_ROUTING_NODE_LIMIT`, `LAYOUT_EDGE_ROUTING_EDGE_LIMIT`). Moved out
  of `renderers/` so the layout phase no longer depends on the renderer.
- `packages/app/src/canvas/utils/graphUtils.ts` — node sizing / parent map
  shared with the renderer (`getNodeSize`, `buildParentMap`).
- `packages/app/src/canvas/renderers/PixiRenderer.ts` — owns the queue,
  `updateGraph` / `updateEdges` / `updateVisibility`, the `_layoutRequestId`
  stale guard and the edge-legend publish.

## Test Files

| File | What it tests |
|------|---------------|
| `packages/app/tests/relayoutPolicy.test.ts` | The trigger policy table |
| `packages/app/tests/layoutScheduler.test.ts` | Run-latest coalescing, error draining |
| `packages/app/tests/edgeRebuild.test.ts` | Edge-phase rebuild: polyline reuse + the drawing pass's anchored-polyline contract (seam test) |
| `packages/app/tests/elkEdgeId.test.ts` | Edge-id round-tripping and rejection of foreign ids |
| `packages/app/tests/elkExtract.test.ts` | Position extraction (nested offsets, unsized nodes), the anchor decided per route, ID-based view-edge resolution, the section-less fallback, and the anchor round trip into the draw-time pipeline |
| `packages/app/tests/edgeGeometry.test.ts` | Exact anchor decisions, the explicit anchored-vs-rerouted result, orthogonal rerouting, obstacle detours |
| `packages/app/tests/routingConstants.test.ts` | The derived `OBSTACLE_QUERY_MARGIN` relationship and the tolerance ordering |
| `packages/app/tests/edgeGeometryBounds.test.ts` | `boundingBox` over empty, overlapping and very large inputs |
| `packages/app/tests/edgeRoutingBudget.test.ts` | The layout-time routing guard (and the draw-time budget) |

## Invariants

- One user action bumps **at most one** trigger counter, hence causes at most one
  layout pass.
- A full layout is the only producer of node positions; the edges phase never
  changes `LayoutResult.nodes` or `renderIds`.
- Only one layout runs at a time; requests arriving during a run collapse into a
  single rerun carrying the newest inputs. A queued full layout absorbs any
  queued edge phase.
- `edgeLegendStore` counts are published only after the `_layoutRequestId` stale
  check, so a superseded pass can never clobber current counts.
- The edges phase never moves the camera; only a full layout refits the viewport.
- A layout that started before a later visibility change re-applies the newest
  visible set when it lands, so a slow layout cannot resurrect hidden nodes.
- Only nodes in `visibleNodes` reach ELK, and a node's children reach it only if
  the node is expanded. `elkNodeIds` is therefore exactly the render set, and it
  is also what is sent to `get_subgraph`.
- A routed edge is mapped back to its view edge by INDEX, never by endpoint pair:
  several edges can join the same pair.
- The routing guard is a pure function of two counts and is the ONLY thing that
  decides whether ELK receives edges. Node positions are always computed.
- Every `LayoutEdge` has at least 2 points and endpoints that lie on its source
  and target boxes (`anchorEdgePolyline`), so downstream code may assume a
  drawable, anchored polyline.
- `LayoutEdge.sourceAnchor` / `targetAnchor` are DECIDED once, by the layout
  phase, and read everywhere else. No consumer re-derives an anchor from a
  polyline; the only place a new anchor is decided later is a dragged node,
  whose stored anchor describes geometry that no longer exists.
- `getAnchorPoint(box, anchor)` reproduces the polyline's endpoint exactly for
  as long as the box has not moved. That is what lets every later stage work
  from `(box, anchor)` instead of from the geometry.
- `anchorEdgePolyline` never silently discards a route: `rerouted` says whether
  the caller is holding the layout's own geometry or a replacement.
- `elkExtract.ts` and `routingConstants.ts` must stay free of runtime imports
  that are not `.ts`-specified pure modules, so the node:test runner can load
  them (ELK's own types are imported type-only).
- `layoutGraph` never rejects: IPC failure yields an empty edge set, and an ELK
  failure yields `fallbackLayout`.
- `relayoutPolicy.ts`, `layoutScheduler.ts` and `layoutRequest.ts` must stay free
  of runtime imports from other `src` modules (type-only imports are fine) so the
  node:test runner can load them.
