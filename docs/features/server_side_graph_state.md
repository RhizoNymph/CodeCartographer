# Server-side Graph State

## Scope

**In scope:**
- Storing the CodeGraph in Tauri managed state on the backend
- Removing `graph_json` parameters from `parse_repo` and `get_subgraph` commands
- Updating frontend commands.ts to stop passing graph JSON
- Updating Toolbar.tsx call sites

**Not in scope:**
- Multi-graph support (only one graph at a time)
- Persistent state across app restarts (graph is in-memory only)
- Concurrent graph mutations (single Mutex serializes all access)

## Data/Control Flow

```
scan_repo(path)
    -> RepoScanner::scan(&path)
    -> Lock GraphState mutex
    -> Store graph clone in state
    -> Return graph to frontend

parse_repo(path, on_event)
    -> Lock GraphState mutex
    -> Take graph out of state (Option::take)
    -> Drop lock
    -> Parse files in parallel (rayon)
    -> Merge results into graph
    -> Resolve references
    -> Lock GraphState mutex
    -> Put updated graph clone back in state
    -> Return graph to frontend

get_subgraph(visible_ids, edge_kinds)
    -> Lock GraphState mutex
    -> Borrow graph reference from state
    -> Build SubGraph from reference
    -> Drop lock
    -> Return SubGraph to frontend
```

## Files

| File | Role | Key exports/interfaces |
|------|------|----------------------|
| `crates/cc-tauri/src/lib.rs` | Defines `GraphState` type | `GraphState` (pub struct) |
| `crates/cc-tauri/src/commands/scan.rs` | Stores graph after scan | `scan_repo` accepts `tauri::State<'_, GraphState>` |
| `crates/cc-tauri/src/commands/parse.rs` | Takes/puts graph from/to state | `parse_repo` and `get_subgraph` accept `tauri::State<'_, GraphState>` |
| `src-tauri/src/lib.rs` | Registers state with `.manage()` | `GraphState::default()` |
| `packages/app/src/api/commands.ts` | Frontend API (no graph param) | `parseRepo(path, onEvent)`, `getSubgraph(visibleIds, edgeKinds)` |
| `packages/app/src/toolbar/Toolbar.tsx` | Calls parseRepo without graph | `openAndScan` callback |

## Invariants and Constraints

1. `GraphState` contains `None` until `scan_repo` is called. Calling `parse_repo` or `get_subgraph` before `scan_repo` returns an error.
2. `parse_repo` uses `Option::take()` to extract the graph, preventing concurrent parses from both seeing the graph. If a second parse is attempted while the first is in progress, it will receive "No graph in state" error.
3. The graph stored in state is always a clone of the returned graph, ensuring the frontend and backend have identical data.
4. The `Mutex` is `std::sync::Mutex`, not `tokio::sync::Mutex`, because the critical sections are short (just clone/swap) and Tauri commands run on a thread pool.
