# Selection (pinned highlight + multi-select induced subgraph)

## Scope

In scope:
- The selected node set as the single source of truth for selection AND for the
  pinned edge highlight (selection and "pin" are the same concept).
- Plain click replaces the selection, ctrl/cmd-click toggles membership,
  empty-canvas click / chip Clear / Esc clears it.
- Highlight precedence: hover > pinned selection > none.
- Induced-subgraph highlighting once two or more nodes are selected.
- Selection surviving base-layer rebuilds (LOD / visibility / layout / drag) and
  being invalidated when nodes leave the graph (new parse).
- Esc precedence: the selection layer consumes Esc before focus handling.

Not in scope:
- What focus mode does with Esc (see zoom_views.md) -- the selection layer only
  decides whether it consumed the key.
- How edges are actually stroked/dimmed (see canvas-rendering.md).
- Sidebar tree rendering (see sidebar.md); it only reads the same store fields.

## The selection model

`packages/app/src/stores/selectionModel.ts` is a dependency-free module (no
zustand, no Pixi, no DOM) holding every selection decision as a pure function.
Everything else adapts its runtime shape onto it.

`SelectionState` encodes the primary/member invariant in the type: it is either
`{ status: "empty" }` or `{ status: "selected"; nodeIds; primaryNodeId }` where
`primaryNodeId` is always a member of `nodeIds`. Only the module's own
constructor builds values, so an empty set with a primary (or a primary outside
the set) is unrepresentable.

| Export | Decision |
|--------|----------|
| `reduceSelection(state, action)` | `replace` / `toggle` / `clear`. Adding makes the node primary; removing a non-primary leaves the primary alone; removing the primary promotes the most recently added survivor. Never mutates. |
| `resolveSelectionClick(nodeId, {ctrlKey, metaKey})` | Ctrl/Cmd-click -> `toggle`, otherwise `replace`. |
| `invalidateSelection(state, nodeExists)` | Drops ids that left the graph, re-deriving the primary if it was dropped. Returns the SAME state object when everything survives, so store subscribers are not woken for a no-op. |
| `resolveHighlightSource(hoveredNodeId, selection)` | hover -> `connected(hovered)`; else 1 selected -> `connected(primary)`; else 2+ -> `induced(nodeIds)`; else `none`. |
| `highlightDimsBaseLayer(source)` | Whether the base edge layer dims (`mode !== "none"`). |
| `resolveSelectionEscape(event, selection)` | `clear-selection` when a selection exists, otherwise `fall-through` with a reason (`not-escape` / `typing` / `no-selection`). |
| `selectionToStore` / `selectionFromStore` | Adapters between the union type and the flat store fields. `selectionFromStore` repairs an inconsistent pair rather than trusting it. |

## Store selector surface

`useGraphStore` (`packages/app/src/stores/graphStore.ts`) publishes two flat
fields plus three actions. This is the stable surface other features subscribe
to:

```ts
selectedNodeIds: ReadonlySet<string>;   // source of truth, never mutated in place
selectedNodeId: string | null;          // derived primary (last-selected)

selectNode(nodeId: string, additive?: boolean): void;  // additive = ctrl/cmd held
applySelectionAction(action: SelectionAction): void;   // replace | toggle | clear
clearSelection(): void;
```

Invariant: `selectedNodeId` is `null` iff `selectedNodeIds` is empty, and is
otherwise a member of it. Both fields are replaced together in a single `set()`
(via `selectionToStore`), so a subscriber can never observe them disagreeing.
The empty selection reuses a shared frozen-by-convention empty set, so clearing
an already-empty selection produces no identity change and no re-render.

Consumers pick the field that matches their cardinality: a details panel that
shows one thing reads `selectedNodeId`; anything summarising or iterating reads
`selectedNodeIds`.

## Data/control flow

1. **Click.** `PixiRenderer.addNodeDisplay` wires `pointerdown` to
   `selectNode(nodeId, e.ctrlKey || e.metaKey)`. Empty-canvas `pointerdown` on
   the viewport calls `clearSelection()`. The sidebar row click does the same
   (`selectNode(nodeId, e.ctrlKey || e.metaKey)`), so both surfaces drive one set.
2. **Store.** `applySelectionAction` reads the current pair back as a
   `SelectionState`, reduces, and writes `selectionToStore(next)`.
3. **Canvas.** `Canvas.tsx` subscribes to `selectedNodeIds` + `selectedNodeId`
   and calls `renderer.setSelection(ids, primary)`.
4. **Renderer.** `setSelection` restyles only the nodes whose selected-ness
   changed (symmetric difference, so multi-select borders stay correct) and
   calls `applyHighlight()`.
5. **Highlight.** `applyHighlight()` calls `resolveHighlightSource(hovered,
   selection)`, fills `edgeManager.highlightedEdgeIndices` accordingly, and
   pushes `highlightDimsBaseLayer(source)` into
   `edgeManager.setHighlightActive()` -- a highlight-layer-only update, falling
   back to a full redraw only when no base layer exists yet.
6. **Hover.** `setHoveredNode` runs the same `applyHighlight()`, so unhovering
   falls back to the pinned highlight instead of restoring full opacity.
7. **Rebuilds.** `renderFromLayout` recomputes the highlight source before
   `triggerEdgeRedraw()`, and `triggerEdgeRedraw` passes the freshly resolved
   `highlightActive` flag -- this is what makes a pin survive LOD, visibility,
   layout and drag rebuilds.
8. **New graph.** `setGraph` runs `invalidateSelection` against the new node map
   before publishing, dropping ids that no longer exist.
9. **Focus.** `enterFocus` replaces the selection with the focused node.

### Induced subgraph

With 2+ nodes selected the highlight is the induced subgraph: each selected id is
expanded to its subtree (same expansion hover uses, so a collapsed File covers
its symbols), the subtrees are unioned into a member set, and an edge is
highlighted only when BOTH endpoints are members. Selecting two collapsed files
therefore shows exactly the traffic between them and nothing else, with
everything else dimmed by the usual base-layer dim.

## Esc precedence

`useSelectionEscape` (`packages/app/src/canvas/useSelectionEscape.ts`) registers
a **capture-phase** window keydown listener. On Escape it asks
`resolveSelectionEscape`; if the answer is `clear-selection` it calls
`preventDefault()` + `stopImmediatePropagation()` and clears. If the answer is
`fall-through` the event is left completely untouched and the focus layer's own
bubble-phase Escape handling runs unchanged.

Capture phase is the seam: it sits strictly above any bubble-phase window
listener regardless of registration order (keydown targets the focused element,
never `window` itself), so the focus layer can change its Esc semantics freely
without this file knowing. The `typing` guard means Esc inside an input/textarea/
select/contenteditable never touches the selection.

Consequence: because `enterFocus` selects the focused node, Esc while focused
clears the selection first and a second Esc reaches the focus layer.

## Files

| File | Role | Key exports |
|------|------|-------------|
| `packages/app/src/stores/selectionModel.ts` | Pure selection/highlight/Esc decisions | `SelectionState`, `reduceSelection`, `resolveSelectionClick`, `invalidateSelection`, `resolveHighlightSource`, `highlightDimsBaseLayer`, `resolveSelectionEscape`, `selectionToStore`, `selectionFromStore` |
| `packages/app/src/stores/graphStore.ts` | Holds `selectedNodeIds` + derived `selectedNodeId`; `selectNode` / `applySelectionAction` / `clearSelection` | `useGraphStore` |
| `packages/app/src/canvas/useSelectionEscape.ts` | Capture-phase Esc listener sitting above focus-Esc | `useSelectionEscape` |
| `packages/app/src/canvas/renderers/PixiRenderer.ts` | `setSelection`, `applyHighlight`, `rebuildHighlightedEdgeIndices` (connected + induced) | `PixiRenderer` |
| `packages/app/src/canvas/renderers/edgeDrawing.ts` | Applies the highlight to the two edge layers via `setHighlightActive(active)` | `EdgeDrawingManager` |
| `packages/app/src/canvas/SelectionChip.tsx` | Single: kind badge + name + Focus. Multi: "N selected" + `Focus <primary>` + Clear | `SelectionChip` |
| `packages/app/src/sidebar/Sidebar.tsx` | Rows highlight on `selectedNodeIds.has(id)`; click supports ctrl/cmd | `Sidebar` |

## Test Files

| File | What it tests |
|------|---------------|
| `packages/app/tests/selectionModel.test.ts` | Reducer semantics (replace/toggle/clear, primary tracking and promotion, immutability), click -> action mapping, store-shape round trip and repair, invalidation on graph change, highlight-source precedence (hover > pin > none, induced at 2+), Esc precedence |

## Invariants and constraints

- `selectionModel.ts` imports nothing, so it loads directly under `node --test`
  and cannot drag Pixi/zustand/DOM into the test process.
- `selectedNodeId` is null iff `selectedNodeIds` is empty; otherwise a member.
  Both fields are always written together.
- There is exactly ONE single-selection concept. No parallel "pinned node" field
  exists, and none should be added.
- Hover never mutates the selection; the selection never suppresses hover.
- All base-layer dimming still goes through `EdgeDrawingManager`'s private
  `setBaseLayerAlpha()` (which dims the count-chip layer in lockstep). The
  pinned path reuses the exact same dim as hover -- no second dim path exists.
- `EdgeDrawingManager` knows only `highlightActive: boolean` +
  `highlightedEdgeIndices`; it never learns whether the highlight came from hover
  or from a pin.
- Selection survives base-layer rebuilds; it does not survive a graph swap
  (invalidated in `setGraph`).
