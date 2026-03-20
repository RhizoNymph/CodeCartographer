# cc-tauri Crate

Bridge layer exposing cc-core functionality as Tauri IPC commands.

## Commands

### scan_repo

```rust
#[command]
pub async fn scan_repo(path: String) -> Result<CodeGraph, String>
```

Discovers directory structure and files in a repository.

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
    graph_json: String,
    on_event: Channel<ParseEvent>,
) -> Result<CodeGraph, String>
```

Parses source code, extracts code blocks, and resolves references into edges.

**Parameters:**
- `path` - Repository root path
- `graph_json` - Serialized CodeGraph from `scan_repo`
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
    graph_json: String,
    visible_ids: Vec<String>,
    edge_kinds: Vec<String>,
) -> Result<SubGraph, String>
```

Filters graph to visible nodes and selected edge types.

**Parameters:**
- `graph_json` - Full CodeGraph
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
    │       ↓
    │   Returns CodeGraph (skeleton)
    │
    ├─ invoke("parse_repo", { path, graphJson, onEvent })
    │       ↓
    │   For each file:
    │     ├─ Send FileStart
    │     ├─ Extractor::extract_file()
    │     ├─ Send FileDone
    │       ↓
    │   SymbolTable::build_from_graph()
    │   SymbolTable::resolve_references()
    │       ↓
    │   Send Complete
    │   Returns CodeGraph (full)
    │
    └─ invoke("get_subgraph", { graphJson, visibleIds, edgeKinds })
            ↓
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

**Skipped fields** (not serialized):
- `CodeGraph.forward_adj`
- `CodeGraph.reverse_adj`

These adjacency indexes are rebuilt after deserialization.

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
  graph: CodeGraph,
  onEvent: (event: ParseEvent) => void
): Promise<CodeGraph> {
  const channel = new Channel<ParseEvent>();
  channel.onmessage = onEvent;
  return invoke("parse_repo", {
    path,
    graphJson: JSON.stringify(graph),
    onEvent: channel,
  });
}

export async function getSubgraph(
  graph: CodeGraph,
  visibleIds: string[],
  edgeKinds: string[]
): Promise<SubGraph> {
  return invoke("get_subgraph", {
    graphJson: JSON.stringify(graph),
    visibleIds,
    edgeKinds,
  });
}

export async function cloneGithubRepo(url: string): Promise<string> {
  return invoke("clone_github_repo", { url });
}
```

## Dependencies

| Crate | Purpose |
|-------|---------|
| cc-core | Core parsing/graph logic |
| tauri | Tauri framework |
| serde/serde_json | Serialization |
| tracing | Logging |
