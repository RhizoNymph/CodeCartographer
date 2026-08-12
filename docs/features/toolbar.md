# Toolbar

## Scope
The toolbar provides repository loading controls (open folder, GitHub clone), the
view-mode segmented control, the edge filter checkboxes, and LOD (Level of Detail)
settings for edge visibility.

### In scope
- Open folder dialog via Tauri plugin-dialog
- GitHub repository URL cloning
- Module | Symbol view-mode segmented control
- Hide-unconnected and hide-ambiguous checkboxes (symbol view only)
- LOD settings dropdown panel (minimap/overview opacity, edge visibility)
- Keyboard shortcuts (Ctrl+O, Ctrl+G, Escape)
- Last-folder restoration on startup

### Not in scope
- Edge kind toggles — these live in the canvas `EdgeLegend` overlay, which shows
  each kind with its colour and its edge count for the current view
  (see docs/features/edge-legend.md)
- Canvas rendering controls (handled by canvas-rendering)
- Sidebar tree controls
- Graph layout parameters

## Data/Control Flow
1. User clicks "Open Folder" or enters a GitHub URL.
2. `openAndScan` calls `scanRepo` then `parseRepo` via Tauri IPC.
3. Results are stored in `graphStore` via `setGraph`.
4. The view-mode control dispatches `setViewMode`; the filter checkboxes dispatch
   `setHideUnconnectedNodes` / `setHideAmbiguousEdges`. Each is classified by
   `relayoutPolicy` (graph-layout.md): view mode and hide-unconnected change the
   node set and increment `layoutVersion` (full ELK layout), while
   hide-ambiguous is a pure edge filter and increments `edgeVersion` (edge phase
   only, positions kept).
5. LOD settings dispatch `setEdgeLODSettings` to `viewportStore`, which debounces localStorage writes (500ms).

## Files
- `packages/app/src/toolbar/Toolbar.tsx` -- Main toolbar component with folder/clone controls
- `packages/app/src/toolbar/LODSettingsPanel.tsx` -- Memoized LOD settings dropdown panel

## Key Exports/Interfaces
- `Toolbar` -- React component
- `LODSettingsPanel` -- Memoized panel component; props: `settings`, `onSettingsChange`

## Invariants
- The edge filter row (hide-unconnected, hide-ambiguous, LOD) renders only in symbol
  view with a loaded graph that has edges; module view is import-only.
- Edge kind toggling is owned entirely by `EdgeLegend`; the toolbar neither reads
  `enabledEdgeKinds` nor calls `toggleEdgeKind`.
- LOD settings panel is memoized and receives `EdgeLODSettings` from `viewportStore`.
- localStorage writes for LOD settings are debounced at 500ms to prevent excessive I/O during slider drags.
