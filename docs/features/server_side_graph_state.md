# Server-side Graph State

## Scope

**In scope:**
- Storing the full `CodeGraph` (nodes + edges) in Tauri managed state as the
  single owner of edges.
- `scan_repo` / `parse_repo` returning an edge-less `ParseResult` (node tree +
  connectivity map) instead of the full graph, serialized straight out of the
  live graph (no node-map copy) and with SLIM nodes (no `signature`).
- `get_node_details(node_id)` serving the per-node facts the bulk payload omits.
- `get_subgraph(render_ids, edge_kinds)` computing per-view direct + aggregated
  edges server-side (porting the old client-side `computeAggregatedEdges`).
- Focused read queries over the same server-side graph:
  `get_neighborhood(node_id, depth, edge_kinds)` (bidirectional BFS) and
  `get_edge_detail(source_id, target_id, edge_kinds)` (the inverse of
  aggregation: re-expand ONE aggregated view edge into its underlying edges).
- Frontend consuming the edge-less result and fetching edges per layout.

**Not in scope:**
- Multi-graph support (only one graph at a time).
- Persistent state across app restarts (graph is in-memory only).
- Concurrent graph mutations (the `RwLock`'s write side serializes them; only
  READS run concurrently).

## Data/Control Flow

```
scan_repo(path)
    -> RepoScanner::scan(&path)
    -> GraphState::store(graph): wrap in Arc, write-lock, install
    -> Return ParseResponse(Arc<CodeGraph>) -- serialized as an edge-less
       ParseResult BORROWING the stored graph (node_edge_kinds is empty)

parse_repo(path, on_event)
    -> GraphState::take_for_mutation(): write-lock, Option::take(), unwrap Arc
    -> strip prior parse state (idempotent re-parse)
    -> parse files in parallel (rayon), merge blocks + children,
       emitting one BATCHED ParseEvent::Progress per ~100 files / ~50ms
    -> resolve references into edges, add to graph (edges moved, not cloned)
    -> send ParseEvent::Complete
    -> GraphState::store(graph) and return ParseResponse(Arc<CodeGraph>)
       -- serialized as an edge-less ParseResult + node_edge_kinds map,
          streamed out of the SAME allocation the state holds

get_node_details(node_id)
    -> GraphState::snapshot() (read-lock, clone Arc, drop lock)
    -> NodeDetails::from_graph: the block's signature (None for files/dirs)
    -> Err on unknown id

get_subgraph(render_ids, edge_kinds)
    -> GraphState::snapshot(); run on the blocking pool with no lock held
    -> SubGraph::from_graph(graph, render_ids, enabled_kinds):
         take the graph's CACHED parent map (built once, invalidated on any
           node-map mutation)
         for each edge with an enabled kind:
           both endpoints in render_ids -> direct edge
           else lift each endpoint to nearest rendered ancestor:
             skip if unresolvable, self-loop, or ancestor-containment
             dedup by (source, target); accumulate `count`
    -> Return SubGraph { edges, aggregated_edges } to frontend

get_edge_detail(source_id, target_id, edge_kinds)     [inverse of aggregation]
    -> GraphState::snapshot(); run on the blocking pool with no lock held
    -> CodeGraph::edge_detail(source, target, enabled_kinds):
         None if either id is unknown
         take the graph's CACHED parent map
         keep each edge whose kind is enabled AND whose source endpoint is
           `source`-or-a-descendant AND whose target endpoint is
           `target`-or-a-descendant   (this direction only)
         node_ids = those endpoints + their container chains up to root
    -> Return EdgeDetail { source, target, node_ids, edges } to frontend
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

Frontend nodes carry no `signature`: the details panel and the hover tooltip
fetch it for the ONE node they are showing through `useNodeDetails(nodeId)`
(`api/useNodeDetails.ts`) -- debounced 120ms and stale-guarded by a monotonic
request token, the same shape as the panel's neighborhood fetch.

## API Shapes

```rust
// crates/cc-core/src/model/graph.rs
pub struct ParseResult<'a> {
    pub nodes: &'a NodeMap,          // serialized as SlimNode (no `signature`)
    pub root: NodeId,
    pub edge_count: usize,
    pub node_edge_kinds: HashMap<NodeId, Vec<EdgeKind>>, // endpoint -> distinct kinds
}

// What a command returns: an owned Arc handle serialized as the ParseResult
// above, since a borrowing response cannot outlive the state it reads.
pub struct ParseResponse(pub Arc<CodeGraph>);

pub struct NodeDetails {          // get_node_details(node_id)
    pub id: NodeId,
    pub signature: Option<String>, // None for files/directories
}

// The node map plus its lazily-built, self-invalidating child -> parent index.
pub struct NodeMap { /* Deref -> HashMap<NodeId, CodeNode>; parent_map() */ }

pub struct SubGraph {
    pub edges: Vec<CodeEdge>,             // both endpoints rendered
    pub aggregated_edges: Vec<AggregatedEdge>, // lifted to nearest ancestor, deduped
}

// AggregatedEdge { source, target, kind, count }

pub struct EdgeDetail {
    pub source: NodeId,          // the aggregate's source endpoint
    pub target: NodeId,          // the aggregate's target endpoint
    pub node_ids: Vec<NodeId>,   // endpoints + container chain (as Neighborhood)
    pub edges: Vec<CodeEdge>,    // the underlying edges, this direction only
}

get_subgraph(render_ids: Vec<String>, edge_kinds: Vec<String>) -> SubGraph
get_edge_detail(source_id: String, target_id: String, edge_kinds: Vec<String>)
    -> EdgeDetail
get_node_details(node_id: String) -> NodeDetails
```

```ts
// packages/app/src/api/types.ts
interface ParseResult { nodes; root; edge_count; node_edge_kinds }  // slim nodes
interface NodeDetails { id; signature }
interface CodeGraph  { nodes; root; edgeCount; nodeEdgeKinds: Map<string, EdgeKind[]> }
interface SubGraph   { edges; aggregated_edges }
interface EdgeDetail { source; target; node_ids; edges }
```

## Files

| File | Role | Key exports/interfaces |
|------|------|----------------------|
| `crates/cc-tauri/src/lib.rs` | Defines `GraphState` (RwLock over an `Arc<CodeGraph>`) and its access helpers | `GraphState`, `snapshot`, `store`, `take_for_mutation` |
| `crates/cc-tauri/src/commands/scan.rs` | Scan -> store graph, return `ParseResponse` | `scan_repo` |
| `crates/cc-tauri/src/commands/parse.rs` | Parse -> store graph, return `ParseResponse`; `get_subgraph` computes view edges; `get_neighborhood` / `get_edge_detail` serve the focus queries; `get_node_details` serves the omitted per-node facts | `parse_repo`, `get_subgraph`, `get_neighborhood`, `get_edge_detail`, `get_node_details` |
| `crates/cc-core/src/model/graph.rs` | `NodeMap` (nodes + cached parent map), `SubGraph::from_graph` aggregation, `CodeGraph::neighborhood`, `CodeGraph::edge_detail`, `ParseResult::from_graph`, `ParseResponse`, `SlimNode`, `NodeDetails`, `build_node_edge_kinds`, `is_ancestor_of` / `is_self_or_descendant` | those items |
| `crates/cc-core/src/model/edge.rs` | `EdgeKind::discriminant` for stable ordering | `EdgeKind` |
| `src-tauri/src/lib.rs` | Registers state + commands | `GraphState::default()` |
| `packages/app/src/api/commands.ts` | Frontend API | `scanRepo`, `parseRepo`, `getSubgraph(renderIds, edgeKinds)`, `getNeighborhood`, `getEdgeDetail(sourceId, targetId, edgeKinds)`, `getNodeDetails(nodeId)` |
| `packages/app/src/api/types.ts` | Types | `ParseResult`, `CodeGraph`, `SubGraph`, `Neighborhood`, `EdgeDetail`, `NodeDetails`, `ParseEvent` |
| `packages/app/src/api/useNodeDetails.ts` | Debounced, stale-guarded per-node details fetch shared by the panel and the tooltip | `useNodeDetails` |
| `packages/app/src/stores/graphStore.ts` | Converts `ParseResult` -> `CodeGraph` (Map connectivity) | `setGraph` |
| `packages/app/src/stores/visibilityFilter.ts` | Connectivity filter using `nodeEdgeKinds` | `computeDisplayVisibleNodes` |
| `packages/app/src/canvas/layout/elkLayout.ts` | Fetches view edges, feeds ELK, layout guard | `layoutGraph` |

## Invariants and Constraints

1. `GraphState` is `None` until `scan_repo`; `parse_repo` / `get_subgraph` /
   `get_neighborhood` / `get_edge_detail` before that returns an error.
2. `parse_repo` uses `Option::take()` so a concurrent parse sees an empty state
   and errors rather than racing.
3. The graph in state is the authoritative owner of edges; `ParseResult` and
   `SubGraph` are derived views. NOTHING is copied for the response: the graph
   is shared with the response through an `Arc` and `ParseResult` serializes by
   borrowing the live node map.
3a. The bulk payload's nodes are SLIM: every field except `signature` (the whole
   declaration line of every block, the single largest contributor to the
   payload). It is the only omitted field, and only two surfaces read it -- the
   details panel and the hover tooltip -- each for one node at a time, via
   `get_node_details`. Any field a renderer, the sidebar, the containment tree
   or the visibility filter reads MUST stay in `SlimNode`.
3b. The child -> parent map is cached on `NodeMap` and rebuilt lazily. Its
   correctness rests on `NodeMap::deref_mut` dropping the cache: the nodes
   cannot be mutated except through `DerefMut`, so no mutation path (add_node,
   `get_mut(..).children_mut()`, `retain`, `values_mut`, the re-parse strip) can
   leave it stale. Adding a mutating API that bypasses `DerefMut` would break
   that invariant.
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
6. The lock is a `std::sync::RwLock` and is held only long enough to clone the
   `Arc` (reads) or swap the `Option` (writes) -- never across graph work. The
   CPU-bound query commands run their bodies on `spawn_blocking` over that
   snapshot, so readers never block each other or the async workers.
   `take_for_mutation` unwraps the `Arc` when it is the sole handle (the normal
   case) and copies only if a reader's snapshot is still alive.
7. `edge_detail` is the exact inverse of aggregation for one pair: same kind
   filter, both endpoints scoped to their own subtrees ("self or descendant"),
   and direction-sensitive — `target -> source` edges belong to a different
   aggregate and are never returned. Unknown ids give `None` (an IPC error);
   known ids with no traffic between them give an EMPTY detail, so callers can
   distinguish "no such node" from "nothing there".
8. `edge_detail` emits `node_ids` under the same convention as
   `Neighborhood.node_ids` (endpoints plus container chain to the root). The
   frontend's containment-tree derivation is therefore shared between the two
   focus kinds rather than duplicated.
