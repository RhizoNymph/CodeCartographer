# Canvas Rendering

## Scope

In scope:
- Pixi.js-based interactive graph rendering (nodes, edges, minimap)
- Node creation, styling, and interaction (click, drag, hover, double-click)
- Edge drawing with LOD-based opacity/width, hover/pinned highlighting, and orthogonal routing
- The client-side edge re-routing pass and its cost controls: a per-redraw
  spatial index of obstacle boxes, and a budget gate that degrades routing as
  the view grows
- Edge pointer interaction: distance-based hit testing for hover, and
  double-click on an aggregated edge to drill into it (the focus transition
  itself lives in zoom_views)
- Node border emphasis: selected, endpoint-of-the-hovered-edge, or plain
- "×N" count chips on aggregated (collapsed-container) edges
- Minimap overlay showing node positions and viewport rectangle
- Drag-and-drop with ancestor chain resizing
- LOD (Level of Detail) visibility for labels and edges based on zoom level
- Two-layer edge dirty tracking for efficient highlight updates

Not in scope:
- Graph layout algorithm (see graph-layout.md)
- State management (see stores)
- What drives the highlight (hover vs pinned selection vs induced subgraph) --
  see selection.md; this feature only applies the resolved result
- Tauri IPC / backend operations

## Architecture

The PixiRenderer (orchestrator) delegates to focused sub-modules:

### Module Structure

1. **PixiRenderer.ts** (~565 lines) - Orchestrator
   - Owns the Pixi Application, Viewport, and layer containers
   - Constructor, init, destroy lifecycle
   - `updateGraph()` (full layout), `updateEdges()` (edge-only phase),
     `renderFromLayout()`, `rebuildEdgeDisplays()`, `updateVisibility()`
   - `layoutQueue`: a `CoalescingScheduler<LayoutRequest>` that serialises layout
     work and collapses a burst of requests into ONE rerun (see graph-layout.md)
   - `setHoveredNode()`, `setSelection(nodeIds, primaryId)`, `zoomToNode()`
   - `applyHighlight()` / `rebuildHighlightedEdgeIndices(source)`: resolve and apply
     the hover-or-pin highlight (connected vs induced subgraph)
   - `syncViewportState()`: publishes viewport bounds/scale to the store and adopts
     the resulting LOD, returning whether the LOD changed. Draws nothing -- the
     caller decides what to rebuild.
   - `updateLODVisibility(redrawEdges)`: applies the current LOD to node labels;
     rebuilds the edge layers only when asked to (true while the user zooms,
     false when the caller is about to rebuild them anyway)
   - `fitViewportToLayout(layout)`: centre + zoom-to-fit, extracted so a layout
     application can fit BEFORE the edges are built
   - `hitTestEdge(globalPos)`: nearest rendered edge within a screen-space radius
     (`EDGE_HIT_RADIUS_PX`), via `pointToPolylineDistance` over the polyline that
     was ACTUALLY DRAWN (`edgeManager.resolvedPointsFor(index)`, falling back to
     the layout polyline for an edge no redraw has touched yet). Lane spreading,
     obstacle detours and node drags all move an edge off its layout route, so
     testing the layout polyline would hit an invisible line. Edges are not Pixi
     interactive objects, so both edge hover and edge double-click resolve
     through this one hit test.
   - Wires up interaction event handlers on node displays, plus viewport-level
     edge interactions: throttled hover, and a `pointertap` pair (two taps on the
     SAME edge within `DOUBLE_TAP_MS`) that drills into an AGGREGATED edge
     (`count > 1`) via `enterEdgeFocus` — see docs/features/zoom_views.md. Node
     hover and active drags short-circuit both, so node interactions win.
   - Delegates to EdgeDrawingManager, MinimapRenderer, DragManager

2. **edgeDrawing.ts** (~815 lines) - Layer management and stroking
   - Owns WHAT to draw and HOW it looks. It does not own edge GEOMETRY: every
     routing decision belongs to `layout/edgeRoutePipeline.ts` (see 2e below).
   - `EdgeDrawingManager` class: manages edgeData array, nodeToEdgeIndices map, highlightedEdgeIndices
   - **Two-layer rendering:**
     - `baseLayer` (Graphics): all edges at normal LOD-based opacity. Rebuilt on layout/visibility/LOD/drag.
     - `highlightLayer` (Graphics): only highlighted edges at full opacity. Rebuilt on highlight change only.
   - On highlight: dims baseLayer alpha to 0.15, draws only highlighted edges on highlightLayer -- O(highlighted) not O(total)
   - On highlight removal: restores baseLayer alpha to 1.0, clears highlightLayer
   - `setHighlightActive(active)`: highlight-only update returning true if handled (no full redraw needed).
     The manager is deliberately ignorant of WHERE the highlight came from -- the caller resolves
     hover vs pinned selection vs induced subgraph, fills `highlightedEdgeIndices`, and passes a flag.
   - `redrawEdgesWithHighlight(...)`: full base+highlight layer rebuild:
     1. `snapshotNodeRefs(visibleNodes, getNodeDisplayRef)` -- ONE `NodeDisplayRef`
        per visible node for the whole redraw (never per edge)
     2. `edgeRouteInput(idx, edge, refs)` per visible, LOD-passing edge: pairs the
        layout route + anchors with where the two nodes are on screen right now
     3. ONE call to `routeEdges(inputs, env)` -- all geometry, budget gate
        included. `env.obstacles` is a THUNK (`() => buildObstacleIndex(refs)`),
        so a redraw the gate downgrades to `none` never builds an index it will
        not query
     4. stroke, record each drawn polyline in `resolvedPointsByEdgeIndex`, and
        collect "×N" chip specs at the arc-length midpoint of the polyline that
        was actually drawn
   - `resolvedPointsFor(edgeIndex)`: the polyline that was actually drawn, or
     null before the first redraw. This is what `hitTestEdge` measures against.
   - `buildEdgeData(layout)`: converts LayoutResult edges into EdgeDatum array,
     carrying each edge's layout-time anchors through and pre-parsing each
     `color` into `colorInt` so no redraw ever re-parses a hex string
   - `scheduleEdgeRedraw()` / `flushEdgeRedraw()`: animation frame throttling
   - LOD helper functions: `getLODEdgeOpacity`, `shouldHideEdgeKindAtLOD`, `getLODEdgeWidthMultiplier`
   - Private drawing primitives: `drawEdgePath`, `drawEdgeStartCap`, `drawEdgeArrowhead`
   - Delegates aggregated-edge count chips to `edgeLabels.ts` (see below); owns
     `baseChipLayer` / `highlightChipLayer` alongside the two Graphics layers and
     `setBaseLayerAlpha()` so base edges and their chips dim together on hover

2b. **edgeLabels.ts** (~190 lines) - "×N" count chips for aggregated edges
   - `polylineArcMidpoint(points)`: point at half the **total arc length** of the
     routed polyline (deliberately not the middle vertex, which on orthogonal
     routes usually sits in a corner). Returns `null` only for an empty
     polyline; a zero-length (fully coincident) polyline resolves to its first point.
   - `shouldShowCountChip(count, lod)`: chips only for `count > 1` and only at
     the "detail" LOD -- "overview" and "minimap" are too dense for per-edge text.
   - `chipAlphaForEdge(edgeAlpha)`: clamps to [0,1]; a chip never renders brighter
     than the edge it annotates, so ambiguous-dimmed and LOD-faded edges get
     proportionally faded chips.
   - `formatEdgeCount(count)`, `createEdgeCountChip(spec)`,
     `buildEdgeCountChipLayer(specs)`: rounded dark plate (`#1e293b`) outlined in
     the edge colour with the edge-tinted "×N" label centred on it.
   - The shared `TextStyle` is created lazily (per-chip colour comes from
     `Text.tint`, not a cloned style) so importing the module outside a DOM
     never touches Pixi's text machinery.

2e. **layout/edgeRoutePipeline.ts** (~370 lines) - The single owner of edge geometry

   An edge's polyline used to be mutated by half a dozen loosely-coupled stages
   across three files, each re-deciding for itself which side of a node the edge
   attached to. Now there is ONE composition function whose body IS the stage
   order:

   ```
   routeEdges(inputs, env)
     anchorEndpoints      -> put endpoints on their anchors, at current positions
     [budget gate]           resolveEdgeRoutingMode over the surviving edge count
     spreadEndpointLanes  -> fan out the edges sharing one node side
     detourAroundObstacles-> push routes clear of node/label boxes (gated)
   ```

   - Every stage is a pure `(edges, ctx) -> edges` returning NEW records, so a
     stage's output is exactly what the next stage sees. Nothing is mutated
     across a stage boundary.
   - **The anchor contract.** Stages CONSUME the anchors decided at layout time
     (see graph-layout.md) and derive endpoints from `(box, anchor)` via
     `getAnchorPoint`. No stage reads a polyline back to work out which side an
     edge attached to. A stage that deliberately moves an endpoint (lane
     spreading) emits an UPDATED anchor with it, so anchors and geometry never
     disagree — including the two-point case where moving a source lane drags
     the far end's row with it.
   - **The one fresh decision.** `anchorEndpoints` has three cases: neither box
     moved (snap the stored route onto the stored anchors); both moved by the
     same delta (translate; anchors are box-relative and survive); moved APART
     (the stored anchors describe geometry that no longer exists, so new ones
     are decided facing the opposite box and the edge is re-routed).
   - `RoutedEdge.origin` (`"anchored" | "rerouted" | "reanchored"`) records which
     branch produced the geometry, making `anchorEdgePolyline`'s escalation
     observable instead of silent.
   - The gate sits BETWEEN stages 1 and 2 because it counts the edges that will
     actually be stroked, which is only known once stage 1 has dropped the
     undrawable ones.
   - `obstaclesForEdge` (an rbush query over the edge's own bbox inflated by
     `OBSTACLE_QUERY_MARGIN`, minus its own endpoints' boxes and any box
     swallowing an endpoint centre) lives here too.
   - Runtime imports use `.ts` specifiers and `ObstacleIndex` is imported
     type-only, so the whole module loads under `node --test`.

2c. **layout/edgeRoutingBudget.ts** (~130 lines, pure) - How much routing a view can afford
   - `EdgeRoutingMode` = `"full" | "obstacles" | "none"`, resolved by
     `resolveEdgeRoutingMode({ renderedEdges, visibleNodes, edgesVisible })`
   - `CROSSING_AWARE_EDGE_LIMIT` (250): above this, detour candidates are no longer
     scored against already-routed polylines (that scoring is O(E^2))
   - `OBSTACLE_ROUTING_EDGE_LIMIT` (500) / `OBSTACLE_ROUTING_NODE_LIMIT` (2000):
     above either, obstacle re-routing is skipped entirely and the ELK/straight
     polyline is drawn as-is
   - `routesAroundObstacles(mode)` / `scoresEdgeCrossings(mode)`: the two decisions
     the redraw loop actually reads
   - `shouldSkipLayoutEdgeRouting(nodeCount, edgeCount)` +
     `LAYOUT_EDGE_ROUTING_NODE_LIMIT` (1500) / `LAYOUT_EDGE_ROUTING_EDGE_LIMIT` (3000):
     the layout-time (ELK) guard, kept here so every routing threshold lives in one file
     (consumed by `layout/elkLayout.ts` -- see graph-layout.md)
   - Import-free so it loads under `node --test`
   - Lives in `layout/`, not `renderers/`: `layout/elkLayout.ts` consumes it, and
     a layout module must not depend on the renderer

2f. **layout/routingConstants.ts** (~95 lines, pure) - Every routing tolerance in one place
   - `POINT_TOLERANCE` (0.5, point equality) < `BOUNDARY_TOLERANCE` (4, boundary
     containment) < `NODE_OBSTACLE_MARGIN` (14) < `DETOUR_GUTTER` (28), plus
     `NODE_MOVED_EPSILON` (1), `MAX_OBSTACLE_REROUTE_PASSES` (32) and the lead
     distances
   - `OBSTACLE_QUERY_MARGIN` is DERIVED -- `NODE_OBSTACLE_MARGIN + DETOUR_GUTTER +
     OBSTACLE_QUERY_ALLOWANCE` = 160 -- so the relationship cannot drift the way
     the prose comment it replaced could
   - Two tolerances used to disagree here: the drawing pass had its own 1.5-unit
     "is this point on that box" test alongside `edgeGeometry`'s 4, which is how
     one stage could put an edge on a side another stage did not believe in
   - `edgeGeometry.ts` re-binds the ones in its innermost loops to module-local
     consts (a measured ~8% of the whole routing pass: V8 constant-folds a
     module-scope `const` but not a live imported binding). `routingConstants.ts`
     remains the owner of the values.

2d. **layout/obstacleIndex.ts** (~150 lines) - R-tree over a redraw's obstacle boxes
   - `ObstacleIndex`: bulk-loaded rbush; `query(bounds, excludeA, excludeB)` and
     `queryForPolyline(points, margin, excludeA, excludeB)` return the `NodeBox`es
     near a polyline, minus the boxes owned by the edge's own endpoints
   - `obstacleEntry(ownerId, box)`: a node contributes its body box and (when
     labelled) its label box under ONE owner id, so excluding an endpoint drops both
   - `polylineBounds(points, margin)`: the query window; null for an empty polyline
   - Only rbush is imported at runtime, so it loads under `node --test`

3. **types.ts** (~70 lines) - Shared type definitions
   - `NodeDisplayRef`: lightweight position snapshot for edge routing
   - `EdgeDatum`: normalized edge data built from layout, incl. `colorInt`
     (the pre-parsed `color`)
   - `EdgeStyleConfig`, `EDGE_STYLES`, `DEFAULT_EDGE_STYLE`: per-kind styling constants
   - `NodePadding`: padding for parent nodes containing children
   - Re-exports `NodeDisplay` from nodeCreation

4. **minimapRenderer.ts** (~153 lines) - Minimap overlay
   - `MinimapRenderer` class: manages node dots and viewport rectangle graphics
   - `updateMinimap(...)`: rebuilds static nodes layer on layout change, updates viewport rect
   - `getMinimapGeometry(...)`: computes world-to-minimap coordinate mapping

5. **dragManager.ts** (~244 lines) - Drag state and ancestor resizing
   - `DragManager` class: holds `dragTarget` state
   - `collectDescendants(...)`: gathers child node positions relative to drag parent
   - `resizeAncestorChain(...)`: walks up parent chain, resizing each ancestor
   - Exported helpers: `redrawNodeBg()`, `updateNodeLabelWrap()`, `syncDisplayBounds()`

6. **nodeCreation.ts** (~114 lines) - Node display factory
   - `createNodeDisplay(...)`: creates Container + Graphics + Text for a node
   - `getNodeColor()`, `getNodeLabel()`, `blockKindPrefix()`
   - `getNodeLayer()`: routes nodes to container vs component layer
   - Exports `NodeDisplay` interface used by other modules

7. **nodeEmphasis.ts** (~85 lines) - Node border emphasis model (pure)
   - `NodeEmphasis` = `"none" | "edge-endpoint" | "selected"`, with
     `NODE_EMPHASIS_STYLES` mapping each level to a border colour + width
   - `resolveNodeEmphasis(isSelected, isEdgeEndpoint)`: selection outranks being
     a hovered edge's endpoint
   - `edgeEndpointIds(source, target)` / `emphasisRedrawIds(prev, next)`:
     the hovered edge's endpoints, and the symmetric difference to redraw
   - Import-free so it loads under `node --test`; the pixi side
     (`redrawNodeBg`, `createNodeDisplay`) reads the style table

8. **Re-export shims** (replace dead code):
   - `EdgeRenderer.ts`: re-exports EdgeDrawingManager and related types from edgeDrawing.ts
   - `NodeRenderer.ts`: re-exports from nodeCreation.ts and dragManager.ts
   - `LabelRenderer.ts`: re-exports updateNodeLabelWrap from dragManager.ts
   - `interaction/interactionManager.ts`: re-exports DragManager from dragManager.ts

### Shared Utilities

- **canvas/utils/graphUtils.ts** (~30 lines)
  - `buildParentMap(graph)`: builds child-to-parent ID map (shared with elkLayout)
  - `getNodeSize(node)`: returns minimum width/height by node type (shared with elkLayout)

## Data/Control Flow

1. Canvas component subscribes to graphStore changes
2. When the store's `layoutVersion` bumps (node positions changed), calls
   `pixiRenderer.updateGraph(graph, expanded, visible, edgeKinds, hideAmbiguous)`;
   when `edgeVersion` bumps (only which edges show changed), calls
   `pixiRenderer.updateEdges(edgeKinds, hideAmbiguous)`, which re-fetches the view
   edges and redraws them on the cached positions without touching ELK or the
   camera. Hiding nodes calls `updateVisibility()`. See graph-layout.md for the
   full trigger table.
3. For a full request PixiRenderer builds the parent map and calls `layoutGraph()` (async)
   - `elkLayout.ts` runs ELK in a web worker (via `elkjs/lib/elk-api` with `workerFactory: () => new ElkWorker()`, where `ElkWorker` is imported from `elkjs/lib/elk-worker.min.js?worker`). Layout computation therefore happens off the main thread, so large graphs no longer freeze the UI. `layoutGraph()` is already async and PixiRenderer already discards stale results, so no other behavior changes.
4. On layout result, `renderFromLayout()`. The ORDER is load-bearing -- it is what
   keeps a layout application to exactly ONE full edge rebuild:
   a. Clears existing displays
   b. Creates NodeDisplay for each layout node via `createNodeDisplay()`
   c. Wires event handlers (pointerdown/move/up, pointertap, pointerover/out)
   d. `fitViewportToLayout(layout)` -- centre + zoom-to-fit FIRST
   e. `syncViewportState()` -- adopt the LOD that fit implies (no drawing)
   f. `updateLODVisibility(false)` -- label visibility only, no edge rebuild
   g. `edgeManager.buildEdgeData(layout)`, recompute the highlight indices, then a
      single `triggerEdgeRedraw()`
   The zoom in (d) later fires the viewport's "moved" event; by then the LOD is
   already current, so `onViewportChanged` rebuilds nothing.
5. On viewport move, `onViewportChanged()` syncs the viewport state and updates the
   minimap; it rebuilds edges ONLY when the LOD actually changed (user zooming
   across an LOD boundary must restyle edges; panning must not).
5b. `updateVisibility(visibleNodes)` skips its edge rebuild while a layout request
   is in flight (`_layoutPending`): that rebuild would route the new visible set
   against the stale layout and be discarded moments later anyway.
6. On hover or selection change, `setHoveredNode()` / `setSelection()` both call `applyHighlight()`, which resolves the highlight source (hover > pinned selection > none; induced at 2+ selected), rebuilds the highlighted edge indices, and calls `edgeManager.setHighlightActive()` -- only the highlight layer is rebuilt, not the base layer
7. On drag, globalpointermove updates node positions, resizes ancestors, schedules edge redraw

### Edge Highlight Optimization

Before: hover triggered `triggerEdgeRedraw()` which destroyed ALL edge graphics and rebuilt from scratch -- O(totalEdges).

After: a highlight change calls `edgeManager.setHighlightActive(active)` which:
1. Dims `baseLayer.alpha` to 0.15 via `setBaseLayerAlpha()` (one property set, O(1))
2. Creates a new `highlightLayer` Graphics with only the highlighted edges -- O(highlightedEdges)
3. When the highlight goes away: restores `baseLayer.alpha` to 1.0 and destroys `highlightLayer` -- O(1)

Full base layer rebuilds only happen on layout/visibility/LOD/drag changes. Those
rebuilds re-resolve the highlight source and pass `highlightActive` back in, which
is what makes a pinned selection survive them.

### Edge re-routing cost model

The client-side re-routing pass (obstacle avoidance on top of ELK's routing) used
to be unbounded: it built an obstacle list of EVERY visible node PER EDGE
(O(E x N) iterations and ~10^8 short-lived objects on a 5k-node / 20k-edge view),
then ran up to 32 detour passes per edge, each scoring candidates against every
polyline routed so far (O(E^2)). A large view appeared hung for minutes.

Three things bound it now:

1. **Hoisted node scan.** `snapshotNodeRefs` reads each visible node's
   `NodeDisplayRef` exactly once per redraw; every edge shares the snapshot.
2. **Spatial index.** All obstacle boxes go into one `ObstacleIndex` (rbush) per
   redraw -- built LAZILY, so a redraw the gate downgrades to `none` never pays
   for it -- and each edge queries only the boxes intersecting its own polyline
   bbox inflated by `OBSTACLE_QUERY_MARGIN` (160, computed as the obstacle
   inflation of 14 plus the detour gutter of 28 plus an explicit allowance).
   Per-edge cost is
   O(log N + k) instead of O(N), and the routed result is unchanged: routing the
   query result and routing the full obstacle list produce identical polylines.
3. **Budget gate.** `resolveEdgeRoutingMode` picks `full` / `obstacles` / `none`
   from the rendered-edge and visible-node counts before the routing loop runs
   (see edgeRoutingBudget.ts above). `none` also covers "the LOD renders edges
   fully transparent", where routing is pure waste.

Below the thresholds nothing changed: small graphs still get fully routed,
crossing-aware, obstacle-avoiding edges.

### Highlight source

`PixiRenderer` never asks "is something hovered?" directly -- it calls
`resolveHighlightSource(hoveredNodeId, selection)` (see selection.md) and acts on
the result:

- `connected(nodeId)` -- every edge touching the node's subtree lights up. This is
  both the hover case and the single-pinned-node case.
- `induced(nodeIds)` -- each selected id is expanded to its subtree, the subtrees
  are unioned, and only edges with BOTH endpoints in that union light up.
- `none` -- no dimming; the base layer renders at full opacity.

### Hovered-edge endpoint emphasis

Edge hover has a node-side counterpart, separate from the edge highlight above:
`Canvas` feeds `hoveredEdgeInfo`'s endpoints to
`PixiRenderer.setHoveredEdgeEndpoints(source, target)`, which redraws just those
nodes' backgrounds with a lighter-blue border. This answers "where does this
edge actually land?" without tracing the polyline by eye -- the tooltip only
names the endpoints in text.

Each affected node is redrawn at its RESOLVED emphasis
(`resolveNodeEmphasis`), so a selected endpoint keeps its selected border, and
only the symmetric difference of the endpoint set is touched per hover change.

## Files

| File | Role | Key Exports |
|------|------|-------------|
| `packages/app/src/canvas/renderers/PixiRenderer.ts` | Orchestrator | `PixiRenderer` class |
| `packages/app/src/canvas/renderers/edgeDrawing.ts` | Edge layers + stroking (two-layer) | `EdgeDrawingManager` (incl. `resolvedPointsFor`), `getLODEdgeOpacity`, etc. |
| `packages/app/src/canvas/layout/edgeRoutePipeline.ts` | The draw-time route pipeline (single owner of edge geometry) | `routeEdges`, `anchorEndpoints`, `anchorEdgeRoute`, `spreadEndpointLanes`, `detourAroundObstacles`, `obstaclesForEdge`, `laneOffset`, `EdgeRouteInput`, `RoutedEdge`, `EdgeRouteEnv` |
| `packages/app/src/canvas/layout/routingConstants.ts` | All routing tolerances/margins (pure, derived arithmetic) | `POINT_TOLERANCE`, `BOUNDARY_TOLERANCE`, `NODE_MOVED_EPSILON`, `NODE_OBSTACLE_MARGIN`, `DETOUR_GUTTER`, `OBSTACLE_QUERY_MARGIN` |
| `packages/app/src/canvas/layout/edgeRoutingBudget.ts` | Routing budget/thresholds (pure) | `EdgeRoutingMode`, `resolveEdgeRoutingMode`, `routesAroundObstacles`, `scoresEdgeCrossings`, `shouldSkipLayoutEdgeRouting` |
| `packages/app/src/canvas/layout/obstacleIndex.ts` | Per-redraw R-tree of obstacle boxes | `ObstacleIndex`, `obstacleEntry`, `polylineBounds` |
| `packages/app/src/canvas/renderers/edgeLabels.ts` | Aggregated-edge "×N" count chips | `polylineArcMidpoint`, `shouldShowCountChip`, `chipAlphaForEdge`, `buildEdgeCountChipLayer` |
| `packages/app/src/canvas/renderers/types.ts` | Shared types | `EdgeDatum`, `NodeDisplayRef`, `EDGE_STYLES`, `NodePadding` |
| `packages/app/src/canvas/renderers/minimapRenderer.ts` | Minimap | `MinimapRenderer` |
| `packages/app/src/canvas/renderers/dragManager.ts` | Drag + resize | `DragManager`, `redrawNodeBg`, `syncDisplayBounds` |
| `packages/app/src/canvas/renderers/nodeCreation.ts` | Node factory | `createNodeDisplay`, `NodeDisplay`, `getNodeLayer` |
| `packages/app/src/canvas/renderers/nodeEmphasis.ts` | Node border emphasis (pure) | `NodeEmphasis`, `NODE_EMPHASIS_STYLES`, `resolveNodeEmphasis`, `edgeEndpointIds`, `emphasisRedrawIds` |
| `packages/app/src/canvas/renderers/EdgeRenderer.ts` | Re-export shim | Re-exports from edgeDrawing.ts |
| `packages/app/src/canvas/renderers/NodeRenderer.ts` | Re-export shim | Re-exports from nodeCreation.ts + dragManager.ts |
| `packages/app/src/canvas/renderers/LabelRenderer.ts` | Re-export shim | Re-exports from dragManager.ts |
| `packages/app/src/canvas/interaction/interactionManager.ts` | Re-export shim | Re-exports DragManager |
| `packages/app/src/canvas/utils/graphUtils.ts` | Shared utils | `buildParentMap`, `getNodeSize` |
| `packages/app/src/canvas/Canvas.tsx` | React component | Canvas mount/unmount, store subscriptions |

## Test Files

| File | What it tests |
|------|---------------|
| `packages/app/tests/edgeRenderer.test.ts` | Edge index building, highlight collection, two-layer invariants, EDGE_STYLES |
| `packages/app/tests/nodeRenderer.test.ts` | Node labels, colors, blockKindPrefix, selected-node state machine, color constants |
| `packages/app/tests/edgeGeometry.test.ts` | Edge routing geometry: exact anchor decisions (`edgeAnchorAtBoundary`), the explicit anchored-vs-rerouted result of `anchorEdgePolyline`, `rerouteOrthogonalEdge`, obstacle detours |
| `packages/app/tests/edgeRoutePipeline.test.ts` | Stage order and hand-off, no cross-stage mutation, the anchor contract (survival, lane-offset updates, fresh anchors after a drag), the anchored/rerouted/reanchored origin, and the budget gate (incl. that `none` never builds an obstacle index) |
| `packages/app/tests/routingConstants.test.ts` | The DERIVED constant relationship (`OBSTACLE_QUERY_MARGIN`) and the tolerance ordering |
| `packages/app/tests/edgeGeometryBounds.test.ts` | `boundingBox`: coverage, empty input, and 10k boxes without a spread-argument overflow |
| `packages/app/tests/obstacleIndex.test.ts` | Query windows, owner exclusion (body + label), locality of results |
| `packages/app/tests/edgeRoutingBudget.test.ts` | Routing-mode thresholds, monotonicity, layout-time routing guard |
| `packages/app/tests/edgeLabels.test.ts` | Arc-length midpoint, count-chip LOD/count predicate, chip alpha clamping, label formatting |
| `packages/app/tests/nodeEmphasis.test.ts` | Emphasis precedence (selected > edge-endpoint > none), border style table, hovered-edge endpoint ids, redraw diffing |
| `packages/app/tests/selectionModel.test.ts` | Highlight-source precedence (hover > pin > none, induced at 2+), selection reducer, invalidation, Esc precedence (see `docs/features/selection.md`) |
| `packages/app/tests/palette.test.ts` | Palette invariants: merged edge hues, cross-map hex/near-duplicate collisions, saturation ordering, contrast on the dark canvas (see `docs/features/palette.md`) |

## Invariants and Constraints

- Node borders have exactly one source of truth: `NODE_EMPHASIS_STYLES`. Both
  the create path (`createNodeDisplay`) and the redraw path (`redrawNodeBg`)
  read it, so a node's border cannot drift between creation and restyle.
- Selection outranks hovered-edge-endpoint emphasis; a pinned node never looks
  less selected because an edge touching it is hovered.

- No circular dependencies between extracted modules. PixiRenderer imports from all sub-modules but sub-modules do not import from PixiRenderer.
- `edgeDrawing.ts` receives node display info via a callback (`getNodeDisplayRef`) rather than holding a reference to the nodeDisplays map.
- `dragManager.ts` and `minimapRenderer.ts` receive all needed state as function parameters (no global state access except BLOCK_COLORS constant).
- `nodeCreation.ts` does NOT attach event handlers -- the orchestrator is responsible for wiring interactions.
- All `console.log` calls have been replaced with `useDebugStore.getState().addLog()` behind `import.meta.env.DEV` guards. `console.warn` and `console.error` are preserved for genuine warnings/errors.
- The base edge layer is only rebuilt on layout/visibility/LOD/drag changes. Highlight-only updates (hover or selection) only touch the highlight layer.
- Applying a layout performs EXACTLY ONE full edge rebuild. `updateLODVisibility`
  cannot rebuild edges unless its caller asks it to, `onViewportChanged` rebuilds
  only on an actual LOD change, and `updateVisibility` stands down while a layout
  is pending.
- No per-edge scan of the node set exists anywhere in the redraw path. Node refs
  are snapshotted once and obstacles are always reached through `ObstacleIndex`.
- Routing degrades, it never blocks: past the budget thresholds edges are drawn
  exactly as the layout produced them rather than routed slowly.
- "×N" chips are placed at the arc-length midpoint of the polyline that was
  ACTUALLY drawn, in every routing mode -- chip placement reads `points` after
  the (possibly skipped) routing pass, not before.
- `EdgeDatum.colorInt` is the single parsed form of `color`; the redraw loop
  never parses a colour string.
- The polyline arrays stored in `resolvedPointsByEdgeIndex` are the same arrays
  the base layer drew (no defensive copy): routing always produces fresh arrays
  and nothing mutates a resolved polyline in place.
- Edge geometry has exactly ONE owner: `layout/edgeRoutePipeline.ts`.
  `edgeDrawing.ts` decides what to route and strokes the answer; it computes no
  route, moves no endpoint and infers no anchor.
- An edge's anchors are DECIDED once, at layout time, and consumed everywhere
  else. No draw-time stage re-derives an anchor from a polyline. The single
  exception is a node dragged away from its laid-out position, where the stored
  anchor describes geometry that no longer exists.
- Anchors and geometry never disagree: a stage that moves an endpoint emits the
  updated anchor with it, and every edge the pipeline emits satisfies
  `points[0] === getAnchorPoint(sourceBox, sourceAnchor)` and likewise at the
  target end (with >= 2 points).
- Every stage returns new records; nothing is mutated across a stage boundary,
  so a stage's input is exactly its predecessor's output.
- Hit testing measures the polyline that was DRAWN, never the layout polyline,
  whenever a resolved one exists. Hover, the tooltip and drill-in therefore
  always agree with what is on screen.
- Routing tolerances have one source of truth (`layout/routingConstants.ts`);
  no stage carries a private tolerance for the same question. `edgeGeometry.ts`
  re-binds hot ones as module-local consts for V8, but never restates a value.
- Hover and pin share ONE dim path: both go through `setBaseLayerAlpha()`. No second dimming mechanism exists, so base edges and their count chips can never drift out of lockstep.
- `EdgeDrawingManager` receives only `highlightActive: boolean` + `highlightedEdgeIndices`; it never learns whether the highlight came from hover, a pin, or an induced subgraph.
- Count chips are built inside the same pass that strokes the edges, so they are rebuilt exactly when their layer is (including drag redraws) and add no per-frame work. Chips are world-space children of the edge layer, so they scale with zoom.
- Allocation per rebuild is bounded by the number of `count > 1` edges in view. Aggregated edges only exist for collapsed containers, so this stays small.
- A chip's alpha equals its edge's alpha (`chipAlphaForEdge`), and `setBaseLayerAlpha()` dims base edges and base chips together, so a chip can never read brighter than the edge it labels.
- The public API of PixiRenderer (as consumed by Canvas.tsx) is: constructor, waitForInit, updateGraph, updateEdges, updateVisibility, setSelection, setHoveredNode, setHoveredEdgeEndpoints, refreshEdges, zoomToNode, destroy. (`setSelectedNode` was replaced by `setSelection(nodeIds, primaryId)` when selection became a set.)
