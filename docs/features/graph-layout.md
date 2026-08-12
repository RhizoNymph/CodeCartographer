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
- The per-view `get_subgraph` fetch and its derived `edgeKindCounts`.
- Coalescing concurrent layout requests and discarding stale results.
- The relayout trigger policy and the store's trigger counters.

### Not in scope
- What the edges *look like* once positioned (see canvas-rendering).
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
  ELK layered layout (routing skipped above 1500 nodes)
  extractLayout -> positions + routed polylines (straightLineEdges as fallback)

edgePhase.layoutEdgePhase(previous, kinds, hideAmbiguous)
  fetchViewEdges(previous.renderIds, ...)   // same render set, new filters
  rebuildEdges: reuse the previous routed polyline for any edge with the same
    (source, target, kind); straight-line connector for edges appearing anew
  -> LayoutResult with previous.nodes and previous.renderIds unchanged
```

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
  (`layoutGraph`), ELK options, extraction, ELK-failure fallback layout.
- `packages/app/src/canvas/layout/edgePhase.ts` — edges phase
  (`layoutEdgePhase`, `rebuildEdges`).
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
- `packages/app/src/canvas/renderers/PixiRenderer.ts` — owns the queue,
  `updateGraph` / `updateEdges` / `updateVisibility`, the `_layoutRequestId`
  stale guard and the edge-legend publish.
- `packages/app/tests/relayoutPolicy.test.ts`,
  `packages/app/tests/layoutScheduler.test.ts` — node:test coverage.

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
- `relayoutPolicy.ts`, `layoutScheduler.ts` and `layoutRequest.ts` must stay free
  of runtime imports from other `src` modules (type-only imports are fine) so the
  node:test runner can load them.
