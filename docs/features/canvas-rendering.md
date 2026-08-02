# Canvas Rendering

## Scope

In scope:
- Pixi.js-based interactive graph rendering (nodes, edges, minimap)
- Node creation, styling, and interaction (click, drag, hover, double-click)
- Edge drawing with LOD-based opacity/width, hover/pinned highlighting, and orthogonal routing
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
   - `updateGraph()`, `renderFromLayout()`, `updateVisibility()`
   - `setHoveredNode()`, `setSelection(nodeIds, primaryId)`, `zoomToNode()`
   - `applyHighlight()` / `rebuildHighlightedEdgeIndices(source)`: resolve and apply
     the hover-or-pin highlight (connected vs induced subgraph)
   - `hitTestEdge(globalPos)`: nearest rendered edge within a screen-space radius
     (`EDGE_HIT_RADIUS_PX`), via `pointToPolylineDistance` over the routed
     polylines. Edges are not Pixi interactive objects, so both edge hover and
     edge double-click resolve through this one hit test.
   - Wires up interaction event handlers on node displays, plus viewport-level
     edge interactions: throttled hover, and a `pointertap` pair (two taps on the
     SAME edge within `DOUBLE_TAP_MS`) that drills into an AGGREGATED edge
     (`count > 1`) via `enterEdgeFocus` — see docs/features/zoom_views.md. Node
     hover and active drags short-circuit both, so node interactions win.
   - Delegates to EdgeDrawingManager, MinimapRenderer, DragManager

2. **edgeDrawing.ts** (~425 lines) - Edge rendering with two-layer architecture
   - `EdgeDrawingManager` class: manages edgeData array, nodeToEdgeIndices map, highlightedEdgeIndices
   - **Two-layer rendering:**
     - `baseLayer` (Graphics): all edges at normal LOD-based opacity. Rebuilt on layout/visibility/LOD/drag.
     - `highlightLayer` (Graphics): only highlighted edges at full opacity. Rebuilt on highlight change only.
   - On highlight: dims baseLayer alpha to 0.15, draws only highlighted edges on highlightLayer -- O(highlighted) not O(total)
   - On highlight removal: restores baseLayer alpha to 1.0, clears highlightLayer
   - `setHighlightActive(active)`: highlight-only update returning true if handled (no full redraw needed).
     The manager is deliberately ignorant of WHERE the highlight came from -- the caller resolves
     hover vs pinned selection vs induced subgraph, fills `highlightedEdgeIndices`, and passes a flag.
   - `redrawEdgesWithHighlight(...)`: full base+highlight layer rebuild
   - `buildEdgeData(layout)`: converts LayoutResult edges into EdgeDatum array
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

3. **types.ts** (~70 lines) - Shared type definitions
   - `NodeDisplayRef`: lightweight position snapshot for edge routing
   - `EdgeDatum`: normalized edge data built from layout
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
2. On graph/expansion/visibility change, calls `pixiRenderer.updateGraph(graph, expanded, visible, edgeKinds)`
3. PixiRenderer builds parent map, calls `layoutGraph()` (async)
   - `elkLayout.ts` runs ELK in a web worker (via `elkjs/lib/elk-api` with `workerFactory: () => new ElkWorker()`, where `ElkWorker` is imported from `elkjs/lib/elk-worker.min.js?worker`). Layout computation therefore happens off the main thread, so large graphs no longer freeze the UI. `layoutGraph()` is already async and PixiRenderer already discards stale results, so no other behavior changes.
4. On layout result, `renderFromLayout()`:
   a. Clears existing displays
   b. Creates NodeDisplay for each layout node via `createNodeDisplay()`
   c. Wires event handlers (pointerdown/move/up, pointertap, pointerover/out)
   d. Calls `edgeManager.buildEdgeData(layout)` then `triggerEdgeRedraw()` (rebuilds base + highlight layers)
   e. Fits viewport to content bounds
5. On viewport move, `onViewportChanged()` updates LOD, redraws edges, updates minimap
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
| `packages/app/src/canvas/renderers/edgeDrawing.ts` | Edge rendering (two-layer) | `EdgeDrawingManager`, `getLODEdgeOpacity`, etc. |
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
| `packages/app/tests/edgeGeometry.test.ts` | Edge routing geometry (anchorEdgePolyline, rerouteOrthogonalEdge) |
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
- Hover and pin share ONE dim path: both go through `setBaseLayerAlpha()`. No second dimming mechanism exists, so base edges and their count chips can never drift out of lockstep.
- `EdgeDrawingManager` receives only `highlightActive: boolean` + `highlightedEdgeIndices`; it never learns whether the highlight came from hover, a pin, or an induced subgraph.
- Count chips are built inside the same pass that strokes the edges, so they are rebuilt exactly when their layer is (including drag redraws) and add no per-frame work. Chips are world-space children of the edge layer, so they scale with zoom.
- Allocation per rebuild is bounded by the number of `count > 1` edges in view. Aggregated edges only exist for collapsed containers, so this stays small.
- A chip's alpha equals its edge's alpha (`chipAlphaForEdge`), and `setBaseLayerAlpha()` dims base edges and base chips together, so a chip can never read brighter than the edge it labels.
- The public API of PixiRenderer (as consumed by Canvas.tsx) is: constructor, waitForInit, updateGraph, updateVisibility, setSelection, setHoveredNode, refreshEdges, zoomToNode, destroy. (`setSelectedNode` was replaced by `setSelection(nodeIds, primaryId)` when selection became a set.)
