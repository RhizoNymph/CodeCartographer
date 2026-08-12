# Parallel File Parsing

## Scope

**In scope:**
- Using rayon `par_iter()` to parse files in parallel
- Collecting results then merging sequentially into the graph
- Sending BATCHED progress events during the sequential merge phase

**Not in scope:**
- Parallel graph mutation (graph mutations remain sequential)
- Parallel symbol resolution (requires full graph, so stays sequential)
- Streaming results to frontend during parallel phase (events sent after collection)

## Data/Control Flow

```
parse_repo(path, on_event, state)
    -> Take graph from GraphState (write lock; Arc unwrapped)
    -> Collect file nodes with languages from graph
    -> Phase 1 (parallel, rayon par_iter):
        For each file node:
            -> Read source file from disk (I/O)
            -> Extractor::extract_file() (Tree-sitter parsing)
            -> Return (file_id, rel_path, Result<(nodes, refs), error>)
        -> Collect all results into Vec
    -> Phase 2 (sequential):
        For each result:
            -> Add nodes to graph, update file children
            -> Collect references (or stage the error in the current batch)
            -> Every 100 files or 50ms: send ONE ParseEvent::Progress
               (cumulative counts + last file + this batch's errors)
        -> Send the final partial batch
    -> Phase 3 (sequential):
        -> Build SymbolTable from graph
        -> Resolve references into edges
        -> Add edges to graph (moved, not cloned)
        -> Send Complete event
    -> Store graph back in GraphState (Arc)
    -> Return ParseResponse(Arc<CodeGraph>), serialized without copying nodes
```

## Files

| File | Role | Key exports/interfaces |
|------|------|----------------------|
| `crates/cc-tauri/src/commands/parse.rs` | Orchestrates parallel parsing | `parse_repo` command |
| `crates/cc-tauri/src/commands/error.rs` | Structured parse error types | `ParseError` enum |
| `crates/cc-tauri/src/commands/mod.rs` | Module exports | `pub mod error` |
| `crates/cc-tauri/Cargo.toml` | rayon + thiserror deps | `rayon`, `thiserror` workspace deps |
| `crates/cc-core/src/parser/extract.rs` | File parsing (called per-file) | `Extractor::extract_file()` |
| `crates/cc-core/src/resolver/symbol_table.rs` | Symbol resolution (sequential) | `SymbolTable::build_from_graph()`, `resolve_references()` |

## Structured Error Types

The `ParseError` enum in `crates/cc-tauri/src/commands/error.rs` provides typed, serializable errors for the parse pipeline:

- `PathNotFound(String)` - Target path does not exist on disk
- `Deserialization(String)` - Failed to deserialize graph data
- `FileParseFailed { file, message }` - Tree-sitter parse failed for a specific file

These errors derive `thiserror::Error`, `Debug`, and `serde::Serialize` so they can be returned directly over Tauri IPC.

## Debug Logging

Diagnostic logging (sample refs and symbols) is gated behind `tracing::event_enabled!(tracing::Level::DEBUG)`. This avoids iterating over collections at INFO level in production. The gate check is a zero-cost no-op when DEBUG is not enabled.

## Invariants and Constraints

1. `Extractor::extract_file()` is stateless and safe to call from multiple threads.
2. Tauri's `Channel<ParseEvent>` is `Send + Sync`, but progress events are sent during the sequential merge phase (not during parallel parsing) to maintain ordering.
2a. Progress is batched (100 files / 50ms), so the merge phase costs O(files/100) IPC messages instead of 2 per file. Per-file failures ride inside the batch's `errors` vec rather than as their own events, and the counts are cumulative snapshots, not deltas.
3. Graph mutations (`add_node`, `add_edge`) happen only in the sequential phases.
4. Symbol resolution requires the complete graph with all nodes, so it must happen after all parallel parsing and sequential merging is complete.
5. File I/O happens during the parallel phase, taking advantage of OS-level I/O parallelism.
6. `ParseError` must remain `Serialize` to cross the Tauri IPC boundary.
