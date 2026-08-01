# Server-side Graph State

## Scope

**In scope:**
- Storing the full `CodeGraph` (nodes + edges) in Tauri managed state as the
  single owner of edges.
- `scan_repo` / `parse_repo` returning an edge-less `ParseResult` (node tree +
  connectivity map) instead of the full graph.
- `get_subgraph(render_ids, edge_kinds)` computing per-view direct + aggregated
  edges server-side (porting the old client-side `computeAggregatedEdges`).
- Frontend consuming the edge-less result and fetching edges per layout.

**Not in scope:**
- Multi-graph support (only one graph at a time).
- Persistent state across app restarts (graph is in-memory only).
- Concurrent graph mutations (single Mutex serializes all access).

## Data/Control Flow

```
scan_repo(path)
    -> RepoScanner::scan(&path)
    -> ParseResult::from_graph(&graph)   (edge-less; node_edge_kinds is empty)
    -> Lock GraphState mutex, move graph into state (no extra clone)
    -> Return ParseResult to frontend

parse_repo(path, on_event)
    -> Lock GraphState mutex, Option::take() the graph, drop lock
    -> strip prior parse state (idempotent re-parse)
    -> parse files in parallel (rayon), merge blocks + children
    -> resolve references into edges, add to graph
    -> ParseResult::from_graph(&graph)   (edge-less + node_edge_kinds map)
    -> Lock mutex, move graph back into state (no extra clone)
    -> Return ParseResult to frontend

get_subgraph(render_ids, edge_kinds)
    -> Lock GraphState mutex, borrow graph
    -> SubGraph::from_graph(graph, render_ids, enabled_kinds):
         build parent map from every node's `children`
         for each edge with an enabled kind:
           both endpoints in render_ids -> direct edge
           else lift each endpoint to nearest rendered ancestor:
             skip if unresolvable, self-loop, or ancestor-containment
             dedup by (source, target); accumulate `count`
    -> Return SubGraph { edges, aggregated_edges } to frontend
```

### Frontend flow (per layout)

`layoutGraph` (elkLayout.ts):
1. Build the ELK node tree from visible/expanded nodes.
2. Collect `elkNodeIds` (the render set).
3. `getSubgraph(renderIds, enabledKinds)` -> direct + aggregated edges.
4. Combine into `ViewEdge[]`, feed to ELK (for routing) and `extractLayout`.
5. If `elkNodeIds.size > 1500`, omit edges from ELK input (skip orthogonal
   routing) and rely on `extractLayout`'s straight-line fallback; a debugStore
   hint suggests Module view / collapsing.

The frontend holds the node tree once (`CodeGraph` no longer carries `edges`).
`computeDisplayVisibleNodes` (visibilityFilter.ts) uses the per-node
`nodeEdgeKinds` connectivity map for the `hideUnconnectedNodes` feature,
synchronously and without edges.

## API Shapes

```rust
// crates/cc-core/src/model/graph.rs
pub struct ParseResult {
    pub nodes: HashMap<NodeId, CodeNode>,
    pub root: NodeId,
    pub edge_count: usize,
    pub node_edge_kinds: HashMap<NodeId, Vec<EdgeKind>>, // endpoint -> distinct kinds
}

pub struct SubGraph {
    pub edges: Vec<CodeEdge>,             // both endpoints rendered
    pub aggregated_edges: Vec<AggregatedEdge>, // lifted to nearest ancestor, deduped
}

// AggregatedEdge { source, target, kind, count }

get_subgraph(render_ids: Vec<String>, edge_kinds: Vec<String>) -> SubGraph
```

```ts
// packages/app/src/api/types.ts
interface ParseResult { nodes; root; edge_count; node_edge_kinds }
interface CodeGraph  { nodes; root; edgeCount; nodeEdgeKinds: Map<string, EdgeKind[]> }
interface SubGraph   { edges; aggregated_edges }
```

## Files

| File | Role | Key exports/interfaces |
|------|------|----------------------|
| `crates/cc-tauri/src/lib.rs` | Defines `GraphState` | `GraphState` (pub struct) |
| `crates/cc-tauri/src/commands/scan.rs` | Scan -> store graph, return `ParseResult` | `scan_repo` |
| `crates/cc-tauri/src/commands/parse.rs` | Parse -> store graph, return `ParseResult`; `get_subgraph` computes view edges | `parse_repo`, `get_subgraph` |
| `crates/cc-core/src/model/graph.rs` | `SubGraph::from_graph` aggregation, `ParseResult::from_graph`, `build_node_edge_kinds`, `build_parent_map` | those items |
| `crates/cc-core/src/model/edge.rs` | `EdgeKind::discriminant` for stable ordering | `EdgeKind` |
| `src-tauri/src/lib.rs` | Registers state + commands | `GraphState::default()` |
| `packages/app/src/api/commands.ts` | Frontend API | `scanRepo`, `parseRepo`, `getSubgraph(renderIds, edgeKinds)` |
| `packages/app/src/api/types.ts` | Types | `ParseResult`, `CodeGraph`, `SubGraph` |
| `packages/app/src/stores/graphStore.ts` | Converts `ParseResult` -> `CodeGraph` (Map connectivity) | `setGraph` |
| `packages/app/src/stores/visibilityFilter.ts` | Connectivity filter using `nodeEdgeKinds` | `computeDisplayVisibleNodes` |
| `packages/app/src/canvas/layout/elkLayout.ts` | Fetches view edges, feeds ELK, layout guard | `layoutGraph` |

## Invariants and Constraints

1. `GraphState` is `None` until `scan_repo`; `parse_repo` / `get_subgraph`
   before that returns an error.
2. `parse_repo` uses `Option::take()` so a concurrent parse sees an empty state
   and errors rather than racing.
3. The graph in state is the authoritative owner of edges; `ParseResult` and
   `SubGraph` are derived views. No full-graph clone is made for the response.
4. `SubGraph::from_graph` aggregation ports the former client
   `computeAggregatedEdges` with one deliberate deviation: skip unresolvable,
   self-loop, and ancestor-containment cases; dedup by (source, target, kind)
   accumulating `count`, so each aggregated edge's kind (and colour) is exact
   and collapsed containers mixing kinds yield parallel per-kind aggregates.
   Direct-pair suppression is also per-kind: a direct edge suppresses only
   same-kind aggregates between the same pair.
5. `node_edge_kinds` records, per endpoint node, the distinct edge kinds
   touching it (sorted by `EdgeKind::discriminant` for determinism). Nodes with
   no edges are absent from the map.
6. The `Mutex` is `std::sync::Mutex` (short critical sections).
