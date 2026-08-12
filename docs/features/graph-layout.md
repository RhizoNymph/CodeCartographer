# Graph Layout

## Scope

In scope:
- Building the ELK node tree for the current view (visible + expanded state)
- Fetching the view's edges (direct + aggregated) from the backend and feeding
  them to ELK for orthogonal routing
- Extracting node positions and routed edge polylines back out of ELK's result
- The layout-time edge-routing guard (when ELK routing is skipped in favour of
  straight-line fallback edges) and the straight-line fallback itself
- The whole-layout fallback used when ELK throws

Not in scope:
- The client-side edge re-routing / obstacle-avoidance pass and its budget --
  that runs at draw time, see canvas-rendering.md
- Pixi rendering, highlighting, LOD (canvas-rendering.md)
- How the view's visible/expanded sets are derived (zoom_views.md,
  state-management)
- Server-side subgraph computation (server_side_graph_state.md)

## Data/Control Flow

1. `PixiRenderer.updateGraph()` calls
   `layoutGraph(graph, expandedNodes, visibleNodes, enabledEdgeKinds, hideAmbiguousEdges)`.
2. `buildElkNode` walks the node tree from the graph root, emitting an `ElkNode`
   per visible node. An expanded node with visible children gets `children` +
   container padding and lets ELK size it; otherwise it carries `getNodeSize`'s
   width/height.
3. `collectElkNodeIds` collects the resulting render set (`elkNodeIds`) -- the
   ids actually laid out, i.e. visible nodes whose ancestors are all expanded.
4. `getSubgraph(renderIds, enabledKinds)` (Tauri IPC) returns the view's direct
   edges (each with a `Resolution`) and aggregated edges (each with a `count`).
   These become `ViewEdge[]`; ambiguous direct edges are dropped here when the
   toolbar toggle asks for it. The same payload derives the legend's per-kind
   counts (`deriveEdgeKindCounts`).
5. **Routing guard.** `shouldSkipLayoutEdgeRouting(elkNodeIds.size, viewEdges.length)`
   (from `renderers/edgeRoutingBudget.ts`) decides whether ELK is given any edges
   at all. Routing cost is driven by EDGES as much as by nodes, so BOTH counts
   gate it:
   - `LAYOUT_EDGE_ROUTING_NODE_LIMIT` = 1500 rendered nodes
   - `LAYOUT_EDGE_ROUTING_EDGE_LIMIT` = 3000 view edges

   Over either limit, `elkEdges` is empty: ELK positions nodes only, and
   `extractLayout` synthesises straight-line fallback edges instead.
6. Each ELK edge id encodes its `viewEdges` INDEX (`elkEdgeId` / `elkEdgeIndex`),
   so extraction maps a routed edge back to exactly the view edge it came from --
   parallel same-pair edges (one aggregate per kind) keep their own
   kind/colour/count.
7. `elk.layout(elkGraph)` runs in a web worker (`elkjs/lib/elk-api` +
   `elk-worker.min.js?worker`), so layout never blocks the UI thread.
8. `extractLayout` walks the result, accumulating parent offsets into absolute
   positions, converts each edge's sections into a `Point[]`, infers source and
   target anchors (`inferEdgeAnchor`) and normalises the polyline through
   `anchorEdgePolyline`. If no routed edges came back (ELK produced none, or
   routing was skipped) it emits a straight-line edge per view edge whose
   endpoints are present.
9. If `elk.layout` throws, `fallbackLayout` lays the visible nodes out on a plain
   grid with no edges, so the canvas still renders something.
10. The `LayoutResult` (nodes, edges, per-kind counts) goes back to
    `PixiRenderer.renderFromLayout`, which is where drawing (and the separate,
    budget-gated client re-routing pass) takes over.

## Files

| File | Role | Key Exports |
|------|------|-------------|
| `packages/app/src/canvas/layout/elkLayout.ts` | ELK graph construction, routing guard, result extraction, fallbacks | `layoutGraph`, `LayoutResult`, `LayoutEdge`, `LayoutNodePosition` |
| `packages/app/src/canvas/layout/elkEdgeId.ts` | Encodes/decodes the viewEdges index in an ELK edge id | `elkEdgeId`, `elkEdgeIndex` |
| `packages/app/src/canvas/layout/edgeGeometry.ts` | Orthogonal polyline geometry: anchors, normalisation, obstacle detours | `anchorEdgePolyline`, `rerouteOrthogonalEdge`, `routePolylineAroundObstacles`, `boundingBox`, `pointToPolylineDistance` |
| `packages/app/src/canvas/renderers/edgeRoutingBudget.ts` | All routing thresholds, layout-time and draw-time | `shouldSkipLayoutEdgeRouting`, `LAYOUT_EDGE_ROUTING_NODE_LIMIT`, `LAYOUT_EDGE_ROUTING_EDGE_LIMIT` |
| `packages/app/src/canvas/utils/graphUtils.ts` | Node sizing / parent map shared with the renderer | `getNodeSize`, `buildParentMap` |

## Test Files

| File | What it tests |
|------|---------------|
| `packages/app/tests/elkEdgeId.test.ts` | Edge-id round-tripping and rejection of foreign ids |
| `packages/app/tests/edgeGeometry.test.ts` | Anchor inference, orthogonal rerouting, obstacle detours |
| `packages/app/tests/edgeGeometryBounds.test.ts` | `boundingBox` over empty, overlapping and very large inputs |
| `packages/app/tests/edgeRoutingBudget.test.ts` | The layout-time routing guard (and the draw-time budget) |

## Invariants and Constraints

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
- `layoutGraph` never rejects: IPC failure yields an empty edge set, and an ELK
  failure yields `fallbackLayout`.
