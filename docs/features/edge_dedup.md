# O(1) Edge Deduplication

## Scope

**In scope:**
- Dedicated `EdgeIndex` struct encapsulating HashMap-based edge dedup logic
- O(1) amortized `add_edge` with weight accumulation for duplicates
- Rebuilding the index during deserialization via `rebuild_adjacency()`
- Tests for correctness (incremental vs bulk rebuild, merge behavior, large-scale dedup)

**Not in scope:**
- Edge removal (not currently needed)
- Thread-safe concurrent edge insertion (graph mutations are sequential)

## Data/Control Flow

```
add_edge(edge)
    -> Call edge_index.get(&source, &target, &kind)
    -> If Some(idx):
        -> Increment weight on existing edge at stored index (saturating_add)
        -> Return (no new edge created)
    -> If None:
        -> idx = edges.len()
        -> edge_index.insert(source, target, kind, idx)
        -> Update forward_adj: source -> (target, idx)
        -> Update reverse_adj: target -> (source, idx)
        -> Push edge to edges Vec

rebuild_adjacency()
    -> Clear forward_adj, reverse_adj
    -> Iterate edges with index
    -> Rebuild forward_adj and reverse_adj
    -> Call edge_index.rebuild(&edges) which clears and repopulates from the Vec
```

## Files

| File | Role | Key exports/interfaces |
|------|------|----------------------|
| `crates/cc-core/src/model/edge_index.rs` | Encapsulated dedup index | `EdgeIndex` (new, get, insert, clear, len, is_empty, rebuild) |
| `crates/cc-core/src/model/graph.rs` | Graph struct using EdgeIndex | `CodeGraph.edge_index`, `add_edge()`, `rebuild_adjacency()` |
| `crates/cc-core/src/model/edge.rs` | Edge types | `EdgeKind` (derives Hash, Eq), `CodeEdge` |
| `crates/cc-core/src/model/node.rs` | Node ID type | `NodeId` (derives Hash, Eq) |
| `crates/cc-core/src/model/mod.rs` | Module exports | `pub mod edge_index` |

## Invariants and Constraints

1. `edge_index` is marked `#[serde(skip)]` and must be rebuilt after deserialization via `rebuild_adjacency()`.
2. The EdgeIndex key is `(NodeId, NodeId, EdgeKind)` - edges are unique per (source, target, kind) triple.
3. The index stored in EdgeIndex corresponds to the position in the `edges` Vec. Edges are append-only; indices are stable.
4. Weight accumulation uses `saturating_add` to prevent overflow.
5. `forward_adj`, `reverse_adj`, and `edge_index` must always be consistent with the `edges` Vec.
6. `EdgeIndex` derives `Clone` and `Default` to match `CodeGraph`'s derive requirements.
