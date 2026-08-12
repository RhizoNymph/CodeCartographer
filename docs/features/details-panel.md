# Details Panel

## Scope

A collapsible right-side panel describing the **selected** node: what it is, and
every edge touching it, grouped by kind and direction. It is the long-term home
for drill-in actions — selection is sticky, so unlike the hover tooltip it can
hold buttons.

### In scope
- Renders only while a node is selected; collapses to a thin vertical "Details"
  reopen tab on the right edge, and disappears entirely when selection clears.
- Header: block-kind badge (`BLOCK_COLORS`) or `File`/`Directory` badge, node
  name, clear-selection and collapse buttons.
- Facts for the selected node: `Path` + `Language` + `Symbols` for files, `Path`
  + `Items` for directories, `Signature` + `Visibility` + `Lines` for code blocks
  (absent signature/visibility are omitted, not rendered blank). The signature is
  NOT in the bulk parse payload — it is fetched for the selected node alone via
  `useNodeDetails` (`get_node_details`, debounced + stale-guarded) and appears a
  beat after the rest of the header; `buildNodeSummary(node, details)` prefers
  the fetched value and falls back to the node's own.
- A prominent "Focus this node" button → `graphStore.enterFocus(selectedNodeId)`.
- Incoming and outgoing edge sections, each grouped by edge kind with an
  `EDGE_COLORS` swatch, the legend's kind label, and a per-kind count.
- One row per other endpoint inside a kind group: name (coloured by block kind),
  a `×N` multiplicity when more than one edge of that kind connects it, click →
  `setSelectedNode(endpointId)`, and a per-row Focus button →
  `enterFocus(endpointId)`.

### Not in scope
- Multi-select. The panel reads a single selected node id (see Invariants).
- Editing, navigation to source, or any write path into the graph.
- Changing what the canvas renders. The panel's `get_neighborhood` fetch is
  independent of focus mode's fetch and never mutates focus/layout state.
- Respecting `enabledEdgeKinds`. The panel always asks for ALL edge kinds — it
  describes the node, not the current view, so hiding a kind on the canvas must
  not silently hide edges here.
- Aggregated (collapsed-container) edges. `get_neighborhood` returns direct edges
  only; the panel reports real edges of the selected node.

## Data / Control Flow

```
selection changes (canvas pointerdown, sidebar row, endpoint row click, enterFocus)
  -> graphStore.selectedNodeId

DetailsPanel (React):
  selectedNodeId <- graphStore            // the panel's ONLY selection read
  graph          <- graphStore
  effect [selectedNodeId, graph]:
      requestId = ++requestIdRef          // monotonic stale token
      clear neighborhood + error, mark pending
      after FETCH_DEBOUNCE_MS (120ms):
          getNeighborhood(selectedNodeId, 1, DETAILS_EDGE_KINDS)
            .then(n => requestId === requestIdRef && setNeighborhood(n))
            .catch(e => requestId === requestIdRef && setError({ message }))
      cleanup: ++requestIdRef (supersede in-flight), clearTimeout

  summary = buildNodeSummary(graph.nodes[selectedNodeId])
  edges   = buildDetailsEdgeModel(selectedNodeId, neighborhood, graph.nodes)
  -> Header / FactList / Focus button / EdgeSection(incoming) + EdgeSection(outgoing)
```

`buildDetailsEdgeModel` is the whole derivation:

1. Drop the neighborhood if `neighborhood.focus !== nodeId` (a response that
   arrived for a superseded selection, belt-and-braces behind the request token).
2. Walk `neighborhood.edges`, which at depth 1 also contains neighbor-to-neighbor
   edges; keep only edges touching `nodeId`. `target === nodeId` → incoming,
   `source === nodeId` → outgoing, both → a self-loop.
3. Accumulate per (direction, kind, other-endpoint id), one count per edge.
4. Emit non-empty groups in `DETAILS_EDGE_KINDS` order; sort endpoints by count
   desc, then name, then id; resolve each endpoint's name/detail/block kind from
   the node map.

## Files

| File | Role |
| --- | --- |
| `packages/app/src/details/detailsPanelModel.ts` | Pure, type-only-import view model. Exports `DETAILS_EDGE_KINDS`, `buildDetailsEdgeModel`, `buildNodeSummary`, `fallbackEndpointName`, `formatSpan` and the `EndpointRow` / `EdgeKindGroup` / `DirectionSection` / `DetailsEdgeModel` / `NodeSummary` / `NodeFact` types. |
| `packages/app/src/details/DetailsPanel.tsx` | Thin React component: one store read for selection, debounced + stale-guarded `get_neighborhood` fetch, collapse state, and rendering. |
| `packages/app/tests/detailsPanel.test.ts` | Unit tests for the model (direction split, stale focus, grouping/ordering, counts, self-loops, name fallbacks, node summaries). |
| `packages/app/src/App.tsx` | Mounts `<DetailsPanel />` in flow after the canvas column, inside an `ErrorBoundary`. |
| `packages/app/src/api/commands.ts` | `getNeighborhood(nodeId, depth, edgeKinds)` — the panel's only IPC call. |
| `packages/app/src/canvas/legend/edgeLegendModel.ts` | `edgeKindLabel` reused for group headings so panel and legend name kinds identically. |

## Invariants and Constraints

- **One selection read.** `DetailsPanel` reads selection through exactly one
  selector (`s => s.selectedNodeId`). When selection becomes a multi-select set
  with a derived primary node, that single line is the only change needed.
- **Stale responses can never render.** Every fetch carries a monotonic request
  id; a response whose id is not the current one is discarded, and the effect
  cleanup supersedes the in-flight request before starting the next. The model
  additionally rejects any `Neighborhood` whose `focus` is not the selected node.
- **`detailsPanelModel.ts` has type-only imports.** It is loaded directly by
  `node --test`, whose type stripping cannot resolve extensionless runtime
  imports between source modules. Runtime lookups (colours, labels) belong in the
  component. `DETAILS_EDGE_KINDS` therefore duplicates `LEGEND_EDGE_KINDS`'
  ordering rather than importing it; the two must stay in sync.
- **An edge counts once, regardless of `weight`.** `weight` is observation
  frequency, not a multiplier — the same rule the edge legend uses, so panel and
  legend counts are comparable.
- **A self-loop is one edge, not two.** It is listed in the outgoing section only
  (flagged `selfLoop`, rendered as "name (self)"), so a section's `total` always
  equals the number of edges it describes.
- **Section totals are consistent.** `section.total` == sum of `group.count` ==
  sum of endpoint `count`s.
- **Endpoint order is deterministic.** count desc → name → node id; no reliance
  on map insertion order.
- **Endpoint names never render empty.** An endpoint missing from `graph.nodes`
  falls back to an id-derived name (`file::name@line` → `name`, `a/b/c.ts` →
  `c.ts`, empty id → `unknown`).
- **The panel is in flow, not an overlay**, so it never covers the graph it
  describes; the canvas's own overlays (legend, chips) keep anchoring to the
  canvas column.
- **Focus buttons live here, never in the tooltip.** The hover tooltip unmounts
  on pointerout before a button in it could be clicked.
