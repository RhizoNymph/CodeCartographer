# Parallel File Parsing

## Scope

**In scope:**
- Using rayon `par_iter()` to parse files in parallel
- Collecting results then merging sequentially into the graph
- Sending progress events during the sequential merge phase

**Not in scope:**
- Parallel graph mutation (graph mutations remain sequential)
- Parallel symbol resolution (requires full graph, so stays sequential)
- Streaming results to frontend during parallel phase (events sent after collection)

## Data/Control Flow

```
parse_repo(path, on_event, state)
    -> Take graph from GraphState
    -> Collect file nodes with languages from graph
    -> Phase 1 (parallel, rayon par_iter):
        For each file node:
            -> Read source file from disk (I/O)
            -> Extractor::extract_file() (Tree-sitter parsing)
            -> Return (file_id, rel_path, Result<(nodes, refs), error>)
        -> Collect all results into Vec
    -> Phase 2 (sequential):
        For each result:
            -> Send FileStart event
            -> Add nodes to graph, update file children
            -> Collect references
            -> Send FileDone/Error event
    -> Phase 3 (sequential):
        -> Build SymbolTable from graph
        -> Resolve references into edges
        -> Add edges to graph
        -> Send Complete event
    -> Store graph back in GraphState
    -> Return graph
```

## Files

| File | Role | Key exports/interfaces |
|------|------|----------------------|
| `crates/cc-tauri/src/commands/parse.rs` | Orchestrates parallel parsing | `parse_repo` command |
| `crates/cc-tauri/Cargo.toml` | rayon dependency | `rayon = { workspace = true }` |
| `crates/cc-core/src/parser/extract.rs` | File parsing (called per-file) | `Extractor::extract_file()` |
| `crates/cc-core/src/resolver/symbol_table.rs` | Symbol resolution (sequential) | `SymbolTable::build_from_graph()`, `resolve_references()` |

## Invariants and Constraints

1. `Extractor::extract_file()` is stateless and safe to call from multiple threads.
2. Tauri's `Channel<ParseEvent>` is `Send + Sync`, but progress events are sent during the sequential merge phase (not during parallel parsing) to maintain ordering.
3. Graph mutations (`add_node`, `add_edge`) happen only in the sequential phases.
4. Symbol resolution requires the complete graph with all nodes, so it must happen after all parallel parsing and sequential merging is complete.
5. File I/O happens during the parallel phase, taking advantage of OS-level I/O parallelism.
