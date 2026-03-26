# Toolbar

## Scope
The toolbar provides repository loading controls (open folder, GitHub clone), edge kind
toggles, and LOD (Level of Detail) settings for edge visibility.

### In scope
- Open folder dialog via Tauri plugin-dialog
- GitHub repository URL cloning
- Edge kind toggle buttons (Import, FunctionCall, MethodCall, etc.)
- LOD settings dropdown panel (minimap/overview opacity, edge visibility)
- Keyboard shortcuts (Ctrl+O, Ctrl+G, Escape)
- Last-folder restoration on startup

### Not in scope
- Canvas rendering controls (handled by canvas-rendering)
- Sidebar tree controls
- Graph layout parameters

## Data/Control Flow
1. User clicks "Open Folder" or enters a GitHub URL.
2. `openAndScan` calls `scanRepo` then `parseRepo` via Tauri IPC.
3. Results are stored in `graphStore` via `setGraph`.
4. Edge toggle buttons dispatch `toggleEdgeKind` to `graphStore`, which increments `layoutVersion`.
5. LOD settings dispatch `setEdgeLODSettings` to `viewportStore`, which debounces localStorage writes (500ms).

## Files
- `packages/app/src/toolbar/Toolbar.tsx` -- Main toolbar component with folder/clone controls
- `packages/app/src/toolbar/EdgeToggleButton.tsx` -- Memoized edge kind toggle button
- `packages/app/src/toolbar/LODSettingsPanel.tsx` -- Memoized LOD settings dropdown panel

## Key Exports/Interfaces
- `Toolbar` -- React component
- `EdgeToggleButton` -- Memoized button component; props: `kind`, `enabled`, `label`, `onToggle`
- `LODSettingsPanel` -- Memoized panel component; props: `settings`, `onSettingsChange`

## Invariants
- Edge toggle buttons are memoized and only re-render when their specific `kind`/`enabled` state changes.
- LOD settings panel is memoized and receives `EdgeLODSettings` from `viewportStore`.
- localStorage writes for LOD settings are debounced at 500ms to prevent excessive I/O during slider drags.
