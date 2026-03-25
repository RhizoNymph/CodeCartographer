# O(1) Edge Deduplication

## Scope

**In scope:**
- HashMap-based edge dedup index on CodeGraph
- O(1) add_edge with weight accumulation for duplicates
- Rebuilding the index during deserialization via rebuild_adjacency
- Tests for correctness

**Not in scope:**
- Edge removal (not currently needed)
- Thread-safe concurrent edge insertion (graph mutations are sequential)

## Data/Control Flow

```
add_edge(edge)
    -> Build key: (source, target, kind)
    -> Lookup key in edge_dedup HashMap
    -> If found:
        -> Increment weight on existing edge at stored index
        -> Return (no new edge created)
    -> If not found:
        -> idx = edges.len()
        -> Insert (key, idx) into edge_dedup
        -> Update forward_adj: source -> (target, idx)
        -> Update reverse_adj: target -> (source, idx)
        -> Push edge to edges Vec

rebuild_adjacency()
    -> Clear forward_adj, reverse_adj, edge_dedup
    -> Iterate edges with index
    -> Rebuild all three indexes
```

## Files

| File | Role | Key exports/interfaces |
|------|------|----------------------|
| `crates/cc-core/src/model/graph.rs` | Graph struct with edge_dedup field | `CodeGraph.edge_dedup`, `add_edge()`, `rebuild_adjacency()` |
| `crates/cc-core/src/model/edge.rs` | Edge types | `EdgeKind` (derives Hash, Eq), `CodeEdge` |
| `crates/cc-core/src/model/node.rs` | Node ID type | `NodeId` (derives Hash, Eq) |

## Invariants and Constraints

1. `edge_dedup` is marked `#[serde(skip)]` and must be rebuilt after deserialization via `rebuild_adjacency()`.
2. The edge_dedup key is `(NodeId, NodeId, EdgeKind)` - edges are unique per (source, target, kind) triple.
3. The index stored in edge_dedup corresponds to the position in the `edges` Vec. Edges are append-only; indices are stable.
4. Weight accumulation uses `saturating_add` to prevent overflow.
5. `forward_adj`, `reverse_adj`, and `edge_dedup` must always be consistent with the `edges` Vec.
