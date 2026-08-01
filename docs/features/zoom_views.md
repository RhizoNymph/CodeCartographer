# Zoom-level Views (Module / Symbol) and Focus Mode

## Scope

**In scope:**
- Two zoom-level views selected by a toolbar segmented control:
  - **Module view** (DEFAULT on repo load): the trustworthy zoomed-out import
    graph. Files render collapsed; only `Import` edges show.
  - **Symbol view**: the detailed zoomed-in view with expandable files and all
    enabled edge kinds, ambiguous styling/toggle, etc.
- Module view as DERIVED constraints over the user's saved state, never a
  mutation of it (saved file expansion is preserved but ignored while in module
  view; effective edge kinds are forced to `{Import}`).
- Per-folder persistence of `viewMode` alongside `expandedNodes`/`visibleNodes`
  (backward compatible with states saved before `viewMode` existed).
- **Focus mode** (drill-down): scope symbol detail to a bounded neighborhood of
  a node so the full symbol graph is never laid out. Backed by the cc-core
  `neighborhood` BFS query and the `get_neighborhood` Tauri command.
- Focus entry points: the `F` hotkey (hovered node, falling back to the selected
  one), the canvas selection chip's "Focus" button, the Sidebar row "Focus"
  button (selected node), and module-view double-click on a File.
- Focus exit: breadcrumb chip overlay (name + 1/2-hop depth selector + X) and
  the Esc key.

**Not in scope:**
- Automatic view switching based on canvas zoom level (view is chosen
  deliberately via the toolbar / entry points).
- Multi-focus / pinned neighborhoods (a single focus node at a time).
- Persisting focus state across reloads (focus is transient; only `viewMode`
  persists).

## Data / Control Flow

### View mode (module vs symbol)

```
graphStore.viewMode: "module" | "symbol"  (default "module", persisted per folder)

Canvas derives the layout inputs each render (graphViewModel.ts):
  layoutEdgeKinds   = effectiveEdgeKinds(enabledEdgeKinds, viewMode)
                        module -> {Import};  symbol -> enabledEdgeKinds
  layoutHideAmbig   = effectiveHideAmbiguous(hideAmbiguousEdges, viewMode)
                        module -> false;     symbol -> hideAmbiguousEdges
  layoutExpanded    = effectiveExpandedNodes(graph, expandedNodes, viewMode)
                        module -> directories only (files dropped)
                        symbol -> expandedNodes unchanged
  displayVisible    = computeDisplayVisibleNodes(graph, visibleNodes,
                        layoutEdgeKinds, hideUnconnectedNodes)

PixiRenderer.updateGraph(graph, layoutExpanded, displayVisible,
                         layoutEdgeKinds, layoutHideAmbig)
  -> elkLayout.layoutGraph(...) -> getSubgraph(renderIds, layoutEdgeKinds)
       -> also derives LayoutResult.edgeKindCounts, which PixiRenderer publishes
          to edgeLegendStore for the EdgeLegend overlay

Switching mode -> graphStore.setViewMode -> reduceSetViewMode + bump
layoutVersion + persist. Entering module view drops any active focus.
```

### Focus mode (drill-down)

```
enterFocus(nodeId, depth) [F hotkey / SelectionChip / Sidebar row /
                           module-view File double-click]
  -> getNeighborhood(nodeId, depth, enabledEdgeKinds)  (Tauri IPC)
       -> cc-core CodeGraph::neighborhood(focus, depth, kinds):
            BFS over BOTH forward_adj and reverse_adj, bounded by depth (1..=2),
            filtered to kinds; collect discovered nodes + direct edges among
            them (with resolution); add the container chain (parents up to root)
            of every discovered node.
  -> store: viewMode="symbol", focusNodeId, focusDepth, focusNeighborhood,
     selectedNode=nodeId, bump layoutVersion   (reduceEnterFocus)

Canvas (isFocused = focusNodeId && focusNeighborhood):
  displayVisible   = focusVisibleNodes(graph, neighborhood.node_ids)
  layoutExpanded   = focusExpandedNodes(graph, neighborhood.node_ids)
                       (containers holding a neighborhood child)
  -> renders ONLY the neighborhood ids; getSubgraph over exactly those render
     ids reproduces the neighborhood's direct edges.

Breadcrumb chip (FocusBreadcrumb.tsx):
  depth selector -> setFocusDepth(d) -> re-enterFocus(focusNodeId, d)
  X / Esc        -> exitFocus -> clear focusNodeId + focusNeighborhood,
                     bump layoutVersion (view mode stays "symbol")
```

### Canvas focus affordances (hotkey + selection chip)

```
window keydown (useFocusHotkey, mounted in App)
  -> describeKeyEvent(e)                       (DOM -> plain fields)
  -> resolveFocusHotkey(event, {hovered, selected, focusNodeId})   (PURE)
       "f"/"F", no ctrl/meta/alt, not typing in INPUT/TEXTAREA/SELECT
       or a contenteditable
       -> target = hoveredNodeId ?? selectedNodeId   (hover wins: enterFocus
          sets selectedNodeId, so a stale selection must not shadow the hover)
       -> {kind:"focus", nodeId} | {kind:"ignore", reason}
  -> enterFocus(nodeId)

SelectionChip (top-centre overlay), shown when selectedNodeId && !focusNodeId:
  name/kind + "Focus (F)" button -> enterFocus(selectedNodeId)
  x -> setSelectedNode(null)
  Selection is sticky (node pointerdown sets it, empty-space pointerdown
  clears it), so the button survives pointer travel.

Tooltip (bottom-centre, hover-driven): shows a non-interactive "F focus" hint
only -- it unmounts on pointerout, so a button there is unreachable.
```

## Related Files

### Backend (Rust)
- `crates/cc-core/src/model/graph.rs`
  - `Neighborhood { focus, depth, node_ids, edges }` (serde) — result type.
  - `CodeGraph::neighborhood(focus, depth, enabled_edge_kinds) -> Option<Neighborhood>`
    — the BFS query; `None` for unknown nodes; depth clamped to `1..=2`. Uses
    `forward_adj` + `reverse_adj` (both directions) and `build_parent_map` for
    the container chain. Neighborhood tests live in the same module.
- `crates/cc-tauri/src/commands/parse.rs`
  - `get_neighborhood(node_id, depth, edge_kinds, state) -> Result<Neighborhood, String>`
    — Tauri command; reads server-side `GraphState` (adjacency is populated via
    `add_edge` during parse and preserved in-process). `parse_edge_kinds` helper
    shared with `get_subgraph`.
- `src-tauri/src/lib.rs` — registers `get_neighborhood` in the invoke handler.

### Frontend (TypeScript)
- `packages/app/src/stores/graphViewModel.ts` — PURE derivation + reducers:
  `effectiveExpandedNodes`, `effectiveEdgeKinds`, `effectiveHideAmbiguous`,
  `focusVisibleNodes`, `focusExpandedNodes`, and the `FocusViewState` reducers
  `reduceSetViewMode` / `reduceEnterFocus` / `reduceExitFocus`.
- `packages/app/src/stores/graphStore.ts` — `viewMode`, `focusNodeId`,
  `focusDepth`, `focusNeighborhood` state; `setViewMode`, `enterFocus`,
  `setFocusDepth`, `exitFocus` actions; restores/persists `viewMode`; resets
  focus on new graph.
- `packages/app/src/stores/persistenceStore.ts` — `ViewMode` type; `viewMode`
  added to `FolderState` (optional; defaults to `"module"` for old states).
- `packages/app/src/canvas/Canvas.tsx` — derives effective layout inputs and
  focus visibility/expansion; feeds them to `PixiRenderer.updateGraph`.
- `packages/app/src/canvas/FocusBreadcrumb.tsx` — the exit chip (name + depth
  selector + X + Esc).
- `packages/app/src/toolbar/Toolbar.tsx` — Module|Symbol segmented control;
  hide-unconnected + ambiguous checkboxes hidden in module view.
- `packages/app/src/canvas/legend/EdgeLegend.tsx` — the edge-kind toggle UI
  (canvas overlay). Collapses to a single non-interactive Import row in module
  view; shows every kind with its per-view count in symbol/focus view.
- `packages/app/src/canvas/focusHotkey.ts` — PURE `resolveFocusHotkey(event,
  context) -> FocusHotkeyResult` (`{kind:"focus"}` | `{kind:"ignore", reason}`);
  no DOM or store imports.
- `packages/app/src/canvas/useFocusHotkey.ts` — window keydown listener that
  adapts the DOM event and dispatches `enterFocus`; mounted once in `App.tsx`.
- `packages/app/src/canvas/SelectionChip.tsx` — top-centre chip for the selected
  node with the "Focus (F)" button; hidden while focus mode is active (the
  breadcrumb owns that slot).
- `packages/app/src/App.tsx` — mounts `useFocusHotkey()`, `<SelectionChip />`,
  and `<EdgeLegend />`.
- `packages/app/src/sidebar/Sidebar.tsx` — "Focus" button on the selected row.
- `packages/app/src/canvas/Tooltip.tsx` — hover tooltip; carries an
  "F focus" hint (no button — see the unreachability invariant).
- `packages/app/src/canvas/renderers/PixiRenderer.ts` — module-view double-click
  on a File calls `enterFocus` instead of `toggleExpanded`.
- `packages/app/src/api/{types,commands}.ts` — `Neighborhood` type +
  `getNeighborhood` command.

### Tests
- `crates/cc-core/src/model/graph.rs` (tests) — neighborhood direction (callers
  AND callees), depth bounds, depth clamping, kind filtering, container-chain
  inclusion, unknown-node error.
- `packages/app/tests/graphViewModel.test.ts` — module-view derivation + focus
  set derivation.
- `packages/app/tests/focusReducer.test.ts` — focus/view reducer transitions.
- `packages/app/tests/focusHotkey.test.ts` — hotkey resolution: hover-over-
  selection precedence, modifier/typing/no-target/already-focused ignores.
- `packages/app/tests/viewModePersistence.test.ts` — viewMode persistence
  round-trip + backward compat.

## Invariants and Constraints

- **Module view is derived, not stored.** `expandedNodes` and `enabledEdgeKinds`
  are never mutated when entering module view; the effective values are computed
  at layout time. Returning to symbol view restores the user's exact state.
- **Module view is import-only.** Effective edge kinds are always `{Import}` and
  the ambiguous filter is a no-op (imports are exact), regardless of the user's
  saved edge-kind toggles. The `EdgeLegend` overlay reflects this by showing a
  single, non-interactive Import row in module view.
- **Default view is module** on load and for any saved state lacking `viewMode`.
- **Focus renders only the neighborhood.** The full symbol graph is never laid
  out; visibility/expansion are restricted to `neighborhood.node_ids`, which
  always include the container chain up to the root so ELK can build the
  containment tree.
- **Neighborhood BFS is bidirectional and bounded.** It follows both
  `forward_adj` (callees) and `reverse_adj` (callers), depth is clamped to
  `1..=2`, and is filtered to the requested edge kinds. Container-chain-only
  nodes contribute no edges.
- **Adjacency availability.** `forward_adj`/`reverse_adj` are `#[serde(skip)]`
  and built by `add_edge`; the server-side state graph retains them in-process,
  so `get_neighborhood` works without an explicit `rebuild_adjacency`.
- **Focus is transient.** Only `viewMode` persists; focus clears on new graph
  load and on switching to module view.
- **Hover-driven overlays never hold actions.** The tooltip unmounts on
  `pointerout`, so any control inside it is destroyed by the pointer travelling
  toward it. Focus actions live on selection-anchored UI (SelectionChip,
  Sidebar row) or the `F` hotkey, which need no pointer travel.
- **Hover wins over selection for the hotkey.** `enterFocus` sets
  `selectedNodeId` to the focus node, so resolving selection first would pin the
  hotkey to the current focus node and make re-focusing by hover impossible.
- **The hotkey yields to text entry.** `f` in an `INPUT`/`TEXTAREA`/`SELECT` or
  contenteditable (e.g. sidebar search) types normally, as does any `f` with
  ctrl/meta/alt held.
- **One top-centre chip at a time.** `SelectionChip` renders only when
  `focusNodeId` is null; `FocusBreadcrumb` only when it is set.
