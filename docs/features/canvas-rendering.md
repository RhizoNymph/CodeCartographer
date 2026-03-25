# Canvas Rendering

## Scope

In scope:
- Pixi.js-based interactive graph rendering (nodes, edges, minimap)
- Node creation, styling, and interaction (click, drag, hover, double-click)
- Edge drawing with LOD-based opacity/width, hover highlighting, and orthogonal routing
- Minimap overlay showing node positions and viewport rectangle
- Drag-and-drop with ancestor chain resizing
- LOD (Level of Detail) visibility for labels and edges based on zoom level

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

2. **edgeDrawing.ts** (~425 lines) - Edge rendering
   - `EdgeDrawingManager` class: manages edgeData array, nodeToEdgeIndices map, highlightedEdgeIndices
   - `buildEdgeData(layout)`: converts LayoutResult edges into EdgeDatum array
   - `redrawEdgesWithHighlight(...)`: full edge redraw with LOD/hover state
   - `scheduleEdgeRedraw()` / `flushEdgeRedraw()`: animation frame throttling
   - LOD helper functions: `getLODEdgeOpacity`, `shouldHideEdgeKindAtLOD`, `getLODEdgeWidthMultiplier`
   - Private drawing primitives: `drawEdgePath`, `drawEdgeStartCap`, `drawEdgeArrowhead`

3. **minimapRenderer.ts** (~153 lines) - Minimap overlay
   - `MinimapRenderer` class: manages node dots and viewport rectangle graphics
   - `updateMinimap(...)`: rebuilds static nodes layer on layout change, updates viewport rect
   - `getMinimapGeometry(...)`: computes world-to-minimap coordinate mapping

4. **dragManager.ts** (~244 lines) - Drag state and ancestor resizing
   - `DragManager` class: holds `dragTarget` state
   - `collectDescendants(...)`: gathers child node positions relative to drag parent
   - `resizeAncestorChain(...)`: walks up parent chain, resizing each ancestor
   - Exported helpers: `redrawNodeBg()`, `updateNodeLabelWrap()`, `syncDisplayBounds()`

5. **nodeCreation.ts** (~114 lines) - Node display factory
   - `createNodeDisplay(...)`: creates Container + Graphics + Text for a node
   - `getNodeColor()`, `getNodeLabel()`, `blockKindPrefix()`
   - `getNodeLayer()`: routes nodes to container vs component layer
   - Exports `NodeDisplay` interface used by other modules

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
   d. Calls `edgeManager.buildEdgeData(layout)` then `triggerEdgeRedraw()`
   e. Fits viewport to content bounds
5. On viewport move, `onViewportChanged()` updates LOD, redraws edges, updates minimap
6. On hover, `setHoveredNode()` rebuilds highlighted edge indices and redraws edges
7. On drag, globalpointermove updates node positions, resizes ancestors, schedules edge redraw

## Files

| File | Role | Key Exports |
|------|------|-------------|
| `packages/app/src/canvas/renderers/PixiRenderer.ts` | Orchestrator | `PixiRenderer` class |
| `packages/app/src/canvas/renderers/edgeDrawing.ts` | Edge rendering | `EdgeDrawingManager`, `EdgeDatum`, `NodeDisplayRef` |
| `packages/app/src/canvas/renderers/minimapRenderer.ts` | Minimap | `MinimapRenderer` |
| `packages/app/src/canvas/renderers/dragManager.ts` | Drag + resize | `DragManager`, `redrawNodeBg`, `syncDisplayBounds` |
| `packages/app/src/canvas/renderers/nodeCreation.ts` | Node factory | `createNodeDisplay`, `NodeDisplay`, `getNodeLayer` |
| `packages/app/src/canvas/utils/graphUtils.ts` | Shared utils | `buildParentMap`, `getNodeSize` |
| `packages/app/src/canvas/Canvas.tsx` | React component | Canvas mount/unmount, store subscriptions |

## Invariants and Constraints

- No circular dependencies between extracted modules. PixiRenderer imports from all sub-modules but sub-modules do not import from PixiRenderer.
- `edgeDrawing.ts` receives node display info via a callback (`getNodeDisplayRef`) rather than holding a reference to the nodeDisplays map.
- `dragManager.ts` and `minimapRenderer.ts` receive all needed state as function parameters (no global state access except BLOCK_COLORS constant).
- `nodeCreation.ts` does NOT attach event handlers -- the orchestrator is responsible for wiring interactions.
- All `console.log` calls have been replaced with `useDebugStore.getState().addLog()` behind `import.meta.env.DEV` guards. `console.warn` and `console.error` are preserved for genuine warnings/errors.
