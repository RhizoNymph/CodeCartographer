# cc-tauri Crate

Bridge layer exposing cc-core functionality as Tauri IPC commands.

## Server-side Graph State

The `GraphState` type wraps a `Mutex<Option<CodeGraph>>` and is registered as Tauri managed state. This eliminates the need to serialize the full graph over IPC for every command:

- `scan_repo` creates the initial graph and stores it in state
- `parse_repo` takes the graph from state, parses, stores it back, and returns it
- `get_subgraph` reads the graph from state without needing it passed over IPC

```rust
pub struct GraphState(pub Mutex<Option<CodeGraph>>);
```

## Commands

### scan_repo

```rust
#[command]
pub async fn scan_repo(
    path: String,
    state: tauri::State<'_, GraphState>,
) -> Result<CodeGraph, String>
```

Discovers directory structure and files in a repository. Stores the result in server-side state.

**Parameters:**
- `path` - Absolute filesystem path to repository

**Returns:** `CodeGraph` with Directory and File nodes (no edges yet)

**Errors:**
- Path doesn't exist
- Path is not a directory
- Scanner errors

### parse_repo

```rust
#[command]
pub async fn parse_repo(
    path: String,
    on_event: Channel<ParseEvent>,
    state: tauri::State<'_, GraphState>,
) -> Result<CodeGraph, String>
```

Parses source code, extracts code blocks, and resolves references into edges.
Reads the graph from server-side state (set by `scan_repo`), parses files in parallel
using rayon, and stores the updated graph back in state.

**Parameters:**
- `path` - Repository root path
- `on_event` - Streaming channel for progress events

**Streaming Events:**
```rust
enum ParseEvent {
    FileStart { path: String },
    FileDone { path: String, blocks: usize },
    Error { path: String, message: String },
    Complete { total_files: usize, total_blocks: usize },
}
```

**Returns:** Enhanced `CodeGraph` with CodeBlock nodes and edges

### get_subgraph

```rust
#[command]
pub async fn get_subgraph(
    visible_ids: Vec<String>,
    edge_kinds: Vec<String>,
    state: tauri::State<'_, GraphState>,
) -> Result<SubGraph, String>
```

Filters graph to visible nodes and selected edge types.
Reads the graph from server-side state.

**Parameters:**
- `visible_ids` - Node IDs to include
- `edge_kinds` - Edge types to include (e.g., `["Import", "FunctionCall"]`)

**Returns:** Filtered `SubGraph` for rendering

### clone_github_repo

```rust
#[command]
pub async fn clone_github_repo(url: String) -> Result<String, String>
```

Clones a GitHub/GitLab repository for analysis.

**Parameters:**
- `url` - GitHub or GitLab HTTPS/SSH URL

**Returns:** Filesystem path to cloned repository

## Data Flow

```
Frontend
    │
    ├─ invoke("clone_github_repo", { url })
    │       ↓
    │   git clone --depth 1
    │       ↓
    │   Returns path
    │
    ├─ invoke("scan_repo", { path })
    │       ↓
    │   RepoScanner::scan()
    │   Store graph in GraphState
    │       ↓
    │   Returns CodeGraph (skeleton)
    │
    ├─ invoke("parse_repo", { path, onEvent })
    │       ↓
    │   Take graph from GraphState
    │   For each file (parallel via rayon):
    │     ├─ Read source file
    │     ├─ Extractor::extract_file()
    │   Merge results sequentially:
    │     ├─ Send FileStart
    │     ├─ Add nodes to graph
    │     ├─ Send FileDone
    │       ↓
    │   SymbolTable::build_from_graph()
    │   SymbolTable::resolve_references()
    │   Store graph in GraphState
    │       ↓
    │   Send Complete
    │   Returns CodeGraph (full)
    │
    └─ invoke("get_subgraph", { visibleIds, edgeKinds })
            ↓
        Read graph from GraphState
        SubGraph::from_graph()
            ↓
        Returns SubGraph
```

## Serialization

All data passes through JSON via serde:

- Frontend calls `invoke()` with JSON arguments
- Backend deserializes to Rust types
- Backend returns `Result<T, String>`
- Tauri serializes result to JSON
- Frontend receives as TypeScript object

**Server-side state:** The graph is kept in memory on the backend via `GraphState`.
Commands read/write it directly, avoiding repeated JSON serialization of the full graph.

**Skipped fields** (not serialized):
- `CodeGraph.forward_adj`
- `CodeGraph.reverse_adj`
- `CodeGraph.edge_dedup`

These indexes are rebuilt after deserialization via `rebuild_adjacency()`.

## Error Handling

All commands return `Result<T, String>`:
- Success: serialized value
- Error: human-readable message

Per-file errors during `parse_repo` are streamed as `ParseEvent::Error` and processing continues.

## Frontend Integration

```typescript
// packages/app/src/api/commands.ts

import { invoke, Channel } from "@tauri-apps/api/core";

export async function scanRepo(path: string): Promise<CodeGraph> {
  return invoke("scan_repo", { path });
}

export async function parseRepo(
  path: string,
  onEvent: (event: ParseEvent) => void
): Promise<CodeGraph> {
  const channel = new Channel<ParseEvent>();
  channel.onmessage = onEvent;
  return invoke("parse_repo", {
    path,
    onEvent: channel,
  });
}

export async function getSubgraph(
  visibleIds: string[],
  edgeKinds: string[]
): Promise<SubGraph> {
  return invoke("get_subgraph", {
    visibleIds,
    edgeKinds,
  });
}

export async function cloneGithubRepo(url: string): Promise<string> {
  return invoke("clone_github_repo", { url });
}
```

Note: The graph is no longer passed from the frontend to `parseRepo` or `getSubgraph`.
The backend maintains the graph in server-side state, eliminating the overhead of
serializing the full graph to JSON for each IPC call.

## Dependencies

| Crate | Purpose |
|-------|---------|
| cc-core | Core parsing/graph logic |
| tauri | Tauri framework |
| serde/serde_json | Serialization |
| tracing | Logging |
| rayon | Parallel file parsing |
