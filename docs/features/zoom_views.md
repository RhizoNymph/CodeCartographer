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
- **Focus stack**: focus is a STACK of frames, not a single node. Focusing a
  node from inside a focused view pushes a deeper frame, making focus mode
  actual graph exploration; the breadcrumb is the trail back out.
- **Directional trace**: each node frame carries a `FocusDirection`
  (`both` | `upstream` = callers only | `downstream` = callees only), applied at
  every BFS hop, toggled per-frame from the breadcrumb.
- Focus entry points: the `F` hotkey (hovered node, falling back to the selected
  one), the canvas selection chip's "Focus" button, the Sidebar row "Focus"
  button (selected node), and module-view double-click on a File.
- Focus exit / navigation: the breadcrumb trail (root "All" chip + one chip per
  frame; earlier chips pop back to that frame, X clears the whole stack) and the
  Esc key, which pops exactly ONE frame.

**Not in scope:**
- Automatic view switching based on canvas zoom level (view is chosen
  deliberately via the toolbar / entry points).
- Multiple simultaneous / pinned neighborhoods (the stack is a single path: one
  frame is rendered at a time).
- Fetching edge frames. The `FocusFrame` union includes an `edge` variant and
  every stack mechanic handles it generically, but the `get_edge_detail` fetch
  lands with `feat/edge-drill-in`.
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

### Focus mode (drill-down) — the focus stack

```
FocusFrame (graphViewModel.ts):
  { type:"node"; nodeId; depth: 1|2; direction: "both"|"upstream"|"downstream" }
| { type:"edge"; source; target }            (fetched by feat/edge-drill-in)

graphStore.focusStack: FocusFrame[]   empty == unfocused
                                      LAST element == the frame on screen
graphStore.focusNeighborhood          the top frame's fetched payload

enterFocus(nodeId, depth?, direction?) [F hotkey / SelectionChip / Sidebar row /
                                        module-view File double-click]
  -> depth/direction default to the CURRENT top frame's (so drilling deeper
     keeps the trace settings), else 1 / "both"
  -> pushFocusFrame(nodeFrame(...)) -> reduceEnterFocus (PURE):
       push a frame, EXCEPT when the new frame targets the same thing as the
       current top frame -- then it replaces it (no duplicate frames), which is
       also how depth/direction changes are expressed.
  -> applyFocusState: fetch the new top frame, commit stack + neighborhood +
     selection + layoutVersion together.

fetch for a node frame:
  getNeighborhood(nodeId, depth, enabledEdgeKinds, direction)  (Tauri IPC)
    -> cc-core CodeGraph::neighborhood(focus, depth, kinds, direction):
         BFS bounded by depth (1..=2), filtered to kinds, following
           both       -> forward_adj + reverse_adj
           upstream   -> reverse_adj only  (callers)
           downstream -> forward_adj only  (callees)
         at EVERY hop; collect discovered nodes + direct edges among them (with
         resolution); add the container chain (parents up to root) of every
         discovered node. `direction` is echoed back on the Neighborhood.

Canvas (isFocused = focusIsActive(focusStack) && focusNeighborhood):
  displayVisible   = focusVisibleNodes(graph, neighborhood.node_ids)
  layoutExpanded   = focusExpandedNodes(graph, neighborhood.node_ids)
                       (containers holding a neighborhood child)
  -> renders ONLY the neighborhood ids; getSubgraph over exactly those render
     ids reproduces the neighborhood's direct edges.

Breadcrumb trail (FocusBreadcrumb.tsx): "Focus  All › a › b › c  [1|2] hops
                                         [callers|both|callees]  ×"
  "All" chip        -> exitFocus            (clear the whole stack)
  earlier chip i    -> popToFrame(i)        (reducePopToFrame: truncate above i,
                                             refetch that frame)
  current chip      -> depth selector    -> setFocusDepth(d)     (top frame only)
                       direction toggle  -> setFocusDirection(d) (top frame only)
  X                 -> exitFocus
  Esc (useEscapeKey)-> popFocus             (reducePopFocus: ONE frame, refetch
                                             the revealed frame; focus ends only
                                             when the stack empties)
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
          focusNodeId here = focusTopNodeId(focusStack): only the frame ON
          SCREEN counts as already-focused, so F on a node deeper in the stack
          is a legitimate re-drill.
  -> enterFocus(nodeId)                        (pushes a frame)

window keydown Escape (useEscapeKey, mounted in App) -- ORDERED chain:
  1. [feat/pinned-selection inserts its "clear pinned selection" step here]
  2. focusStack non-empty -> popFocus()  (consume the key)
  Esc lives in its own window-level hook rather than inside FocusBreadcrumb so
  the chain has one home and steps above the pop can be added cleanly.

SelectionChip (top-centre overlay), shown when selectedNodeId && stack empty:
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
  - `FocusDirection { Both (default) | Upstream | Downstream }` — serde
    `rename_all = "lowercase"`, so the wire format matches the frontend union.
    `follows_forward()` / `follows_reverse()` decide which adjacency each hop
    walks.
  - `Neighborhood { focus, depth, direction, node_ids, edges }` (serde) — result
    type; `direction` echoes the query back.
  - `CodeGraph::neighborhood(focus, depth, enabled_edge_kinds, direction) -> Option<Neighborhood>`
    — the BFS query; `None` for unknown nodes; depth clamped to `1..=2`. Uses
    `forward_adj` and/or `reverse_adj` per `direction` and `build_parent_map`
    for the container chain. Neighborhood tests live in the same module.
- `crates/cc-tauri/src/commands/parse.rs`
  - `get_neighborhood(node_id, depth, edge_kinds, direction, state) -> Result<Neighborhood, String>`
    — Tauri command; reads server-side `GraphState` (adjacency is populated via
    `add_edge` during parse and preserved in-process). `parse_edge_kinds` helper
    shared with `get_subgraph`.
- `src-tauri/src/lib.rs` — registers `get_neighborhood` in the invoke handler.

### Frontend (TypeScript)
- `packages/app/src/stores/graphViewModel.ts` — PURE derivation + reducers:
  `effectiveExpandedNodes`, `effectiveEdgeKinds`, `effectiveHideAmbiguous`,
  `focusVisibleNodes`, `focusExpandedNodes`; the `FocusFrame` type + helpers
  (`nodeFrame`, `focusFrameKey`, `focusTopFrame`, `focusTopNodeId`,
  `focusIsActive`, `focusFrameLabel`, `truncateLabel`); and the
  `FocusViewState { viewMode, focusStack }` reducers `reduceSetViewMode` /
  `reduceEnterFocus` / `reduceExitFocus` / `reducePopFocus` /
  `reducePopToFrame` / `reduceSetFocusDepth` / `reduceSetFocusDirection`.
- `packages/app/src/stores/graphStore.ts` — `viewMode`, `focusStack`,
  `focusNeighborhood` state; `setViewMode`, `enterFocus`, `pushFocusFrame`,
  `setFocusDepth`, `setFocusDirection`, `popFocus`, `popToFrame`, `exitFocus`
  actions; the `fetchFrameNeighborhood` / `applyFocusState` helpers that keep
  `focusNeighborhood` in lockstep with the top frame; restores/persists
  `viewMode`; clears the stack on new graph.
- `packages/app/src/stores/persistenceStore.ts` — `ViewMode` type; `viewMode`
  added to `FolderState` (optional; defaults to `"module"` for old states).
- `packages/app/src/canvas/Canvas.tsx` — derives effective layout inputs and
  focus visibility/expansion; feeds them to `PixiRenderer.updateGraph`.
- `packages/app/src/canvas/FocusBreadcrumb.tsx` — the breadcrumb trail: root
  "All" chip + one chip per frame (truncated node name, or "A → B" for an edge
  frame), with the current frame's depth selector, direction toggle and X.
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
- `packages/app/src/canvas/useEscapeKey.ts` — window Escape listener holding the
  ordered precedence chain (pinned selection first, then pop one focus frame);
  mounted once in `App.tsx`.
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
- `packages/app/src/api/{types,commands}.ts` — `FocusDirection` +
  `Neighborhood` types, `getNeighborhood(nodeId, depth, edgeKinds, direction)`.

### Tests
- `crates/cc-core/src/model/graph.rs` (tests) — bidirectional neighborhood,
  depth bounds, depth clamping, kind filtering, container-chain inclusion,
  unknown-node error; plus the directional trace: upstream excludes callees,
  downstream excludes callers, `Both` is the union and the default, direction
  applies per hop, container chain and kind filtering still hold, and the
  lowercase serde wire format.
- `packages/app/tests/graphViewModel.test.ts` — module-view derivation + focus
  set derivation.
- `packages/app/tests/focusReducer.test.ts` — focus STACK reducer transitions:
  push / replace-top / pop-one / pop-to-frame / clear, successive-Esc unwind
  ordering, per-frame depth + direction changes, view-mode interaction, purity,
  derived accessors, and breadcrumb labelling/truncation.
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
- **Neighborhood BFS is directional and bounded.** It follows `forward_adj`
  (callees) and/or `reverse_adj` (callers) per `FocusDirection` — the SAME
  direction at every hop, so an upstream trace never turns around and pulls in a
  callee of a caller. Depth is clamped to `1..=2` and the walk is filtered to the
  requested edge kinds. Container-chain-only nodes contribute no edges. `Both`
  is the default and is exactly the pre-direction behavior.
- **The top frame owns the neighborhood.** `focusNeighborhood` always belongs to
  `focusStack[last]`: every transition that changes the top frame (push, replace,
  pop, pop-to, depth/direction change) re-fetches before committing, and a failed
  fetch leaves the previous state intact rather than stranding a stale payload.
- **Depth and direction are per-frame.** Changing either rewrites only the top
  frame; parent frames keep the settings they were opened with. A new frame
  INHERITS the current frame's depth/direction when the caller does not specify
  them, so drilling deeper keeps the trace the user set up.
- **The top frame never duplicates.** Entering focus on the target of the
  current top frame replaces that frame instead of pushing; only the top is
  deduped, so re-focusing an ancestor deeper in the trail is a genuine drill-in.
- **Esc pops ONE frame; X clears the stack.** Esc walks back out level by level
  and exits focus only when the stack empties (this replaces the older
  "Esc always exits focus" behavior). The Escape precedence chain lives in
  `useEscapeKey`, ordered so higher-priority consumers (e.g. clearing a pinned
  selection) sit above the pop.
- **Adjacency availability.** `forward_adj`/`reverse_adj` are `#[serde(skip)]`
  and built by `add_edge`; the server-side state graph retains them in-process,
  so `get_neighborhood` works without an explicit `rebuild_adjacency`.
- **Focus is transient.** Only `viewMode` persists; the whole focus stack clears
  on new graph load and on switching to module view.
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
- **One top-centre chip at a time.** `SelectionChip` renders only when the focus
  stack is empty; `FocusBreadcrumb` only when it is not.
- **Breadcrumb chips stay compact.** Frame labels are truncated
  (`truncateLabel`, 18 chars) with the full label kept in the chip's `title`, so
  a deep stack never overflows the top-centre overlay.
