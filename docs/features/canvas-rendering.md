# Canvas Rendering

## Scope

In scope:
- Pixi.js-based interactive graph rendering (nodes, edges, minimap)
- Node creation, styling, and interaction (click, drag, hover, double-click)
- Edge drawing with LOD-based opacity/width, hover highlighting, and orthogonal routing
- Minimap overlay showing node positions and viewport rectangle
- Drag-and-drop with ancestor chain resizing
- LOD (Level of Detail) visibility for labels and edges based on zoom level
- Two-layer edge dirty tracking for efficient hover updates

Not in scope:
- Graph layout algorithm (see graph-layout.md)
- State management (see stores)
- Tauri IPC / backend operations

## Architecture

The PixiRenderer (orchestrator) delegates to focused sub-modules:

### Module Structure

1. **PixiRenderer.ts** (~565 lines) - Orchestrator
   - Owns the Pixi Application, Viewport, and layer containers
   - Constructor, init, destroy lifecycle
   - `updateGraph()`, `renderFromLayout()`, `updateVisibility()`
   - `setHoveredNode()`, `setSelectedNode()`, `zoomToNode()`
   - Wires up interaction event handlers on node displays
   - Delegates to EdgeDrawingManager, MinimapRenderer, DragManager

2. **edgeDrawing.ts** (~425 lines) - Edge rendering with two-layer architecture
   - `EdgeDrawingManager` class: manages edgeData array, nodeToEdgeIndices map, highlightedEdgeIndices
   - **Two-layer rendering:**
     - `baseLayer` (Graphics): all edges at normal LOD-based opacity. Rebuilt on layout/visibility/LOD/drag.
     - `highlightLayer` (Graphics): only connected edges at full opacity. Rebuilt on hover only.
   - On hover: dims baseLayer alpha to 0.15, draws only highlighted edges on highlightLayer -- O(connected) not O(total)
   - On unhover: restores baseLayer alpha to 1.0, clears highlightLayer
   - `setHoveredNode(nodeId)`: hover-only update returning true if handled (no full redraw needed)
   - `redrawEdgesWithHighlight(...)`: full base+highlight layer rebuild
   - `buildEdgeData(layout)`: converts LayoutResult edges into EdgeDatum array
   - `scheduleEdgeRedraw()` / `flushEdgeRedraw()`: animation frame throttling
   - LOD helper functions: `getLODEdgeOpacity`, `shouldHideEdgeKindAtLOD`, `getLODEdgeWidthMultiplier`
   - Private drawing primitives: `drawEdgePath`, `drawEdgeStartCap`, `drawEdgeArrowhead`

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

7. **Re-export shims** (replace dead code):
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
4. On layout result, `renderFromLayout()`:
   a. Clears existing displays
   b. Creates NodeDisplay for each layout node via `createNodeDisplay()`
   c. Wires event handlers (pointerdown/move/up, pointertap, pointerover/out)
   d. Calls `edgeManager.buildEdgeData(layout)` then `triggerEdgeRedraw()` (rebuilds base + highlight layers)
   e. Fits viewport to content bounds
5. On viewport move, `onViewportChanged()` updates LOD, redraws edges, updates minimap
6. On hover, `setHoveredNode()` rebuilds highlighted edge indices, then calls `edgeManager.setHoveredNode()` which only rebuilds the highlight layer (not the base layer)
7. On drag, globalpointermove updates node positions, resizes ancestors, schedules edge redraw

### Edge Hover Optimization

Before: hover triggered `triggerEdgeRedraw()` which destroyed ALL edge graphics and rebuilt from scratch -- O(totalEdges).

After: hover calls `edgeManager.setHoveredNode(nodeId)` which:
1. Dims `baseLayer.alpha` to 0.15 (one property set, O(1))
2. Creates a new `highlightLayer` Graphics with only connected edges -- O(connectedEdges)
3. On unhover: restores `baseLayer.alpha` to 1.0 and destroys `highlightLayer` -- O(1)

Full base layer rebuilds only happen on layout/visibility/LOD/drag changes.

## Files

| File | Role | Key Exports |
|------|------|-------------|
| `packages/app/src/canvas/renderers/PixiRenderer.ts` | Orchestrator | `PixiRenderer` class |
| `packages/app/src/canvas/renderers/edgeDrawing.ts` | Edge rendering (two-layer) | `EdgeDrawingManager`, `getLODEdgeOpacity`, etc. |
| `packages/app/src/canvas/renderers/types.ts` | Shared types | `EdgeDatum`, `NodeDisplayRef`, `EDGE_STYLES`, `NodePadding` |
| `packages/app/src/canvas/renderers/minimapRenderer.ts` | Minimap | `MinimapRenderer` |
| `packages/app/src/canvas/renderers/dragManager.ts` | Drag + resize | `DragManager`, `redrawNodeBg`, `syncDisplayBounds` |
| `packages/app/src/canvas/renderers/nodeCreation.ts` | Node factory | `createNodeDisplay`, `NodeDisplay`, `getNodeLayer` |
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

## Invariants and Constraints

- No circular dependencies between extracted modules. PixiRenderer imports from all sub-modules but sub-modules do not import from PixiRenderer.
- `edgeDrawing.ts` receives node display info via a callback (`getNodeDisplayRef`) rather than holding a reference to the nodeDisplays map.
- `dragManager.ts` and `minimapRenderer.ts` receive all needed state as function parameters (no global state access except BLOCK_COLORS constant).
- `nodeCreation.ts` does NOT attach event handlers -- the orchestrator is responsible for wiring interactions.
- All `console.log` calls have been replaced with `useDebugStore.getState().addLog()` behind `import.meta.env.DEV` guards. `console.warn` and `console.error` are preserved for genuine warnings/errors.
- The base edge layer is only rebuilt on layout/visibility/LOD/drag changes. Hover-only updates only touch the highlight layer.
- The public API of PixiRenderer (as consumed by Canvas.tsx) is unchanged: constructor, waitForInit, updateGraph, updateVisibility, setSelectedNode, setHoveredNode, refreshEdges, zoomToNode, destroy.
