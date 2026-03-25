# cc-core Crate

The core processing engine for CodeCartographer. Handles parsing, graph construction, and reference resolution.

## Module Structure

```
cc-core/
├── model/      # Data structures (nodes, edges, graphs)
├── parser/     # Tree-sitter code extraction
├── repo/       # Repository scanning and cloning
└── resolver/   # Reference resolution (imports, calls, types)
```

## Model Module

### NodeId

Stable identifier for graph nodes using relative paths and block locations.

```rust
NodeId::directory("src")           // Directory node
NodeId::file("src/main.rs")        // File node
NodeId::code_block("src/main.rs", "main", 1)  // "src/main.rs::main@1"
```

### CodeNode (Enum)

Three node variants representing the code hierarchy:

**Directory**
- `id`, `name`, `path`, `children`

**File**
- `id`, `name`, `path`, `language`, `children`

**CodeBlock**
- `id`, `name`, `kind`, `span`, `signature`, `visibility`, `parent`, `children`

### BlockKind

Types of code blocks extracted:

| Kind | Description |
|------|-------------|
| Function | Function/method definition |
| Class | Class definition |
| Struct | Struct definition |
| Enum | Enum definition |
| Trait | Trait definition |
| Interface | Interface definition |
| Impl | Impl block |
| Module | Module definition |
| Constant | Const/static item |
| TypeAlias | Type alias |

### EdgeKind

Relationship types between nodes:

| Kind | Color | Description |
|------|-------|-------------|
| Import | #6366f1 | Module import |
| FunctionCall | #22c55e | Function invocation |
| MethodCall | #14b8a6 | Method invocation |
| TypeReference | #f59e0b | Type usage |
| Inheritance | #ef4444 | Class inheritance |
| TraitImpl | #a855f7 | Trait implementation |
| VariableUsage | #64748b | Variable reference |

### CodeGraph

Complete graph representation:

```rust
pub struct CodeGraph {
    pub nodes: HashMap<NodeId, CodeNode>,
    pub edges: Vec<CodeEdge>,
    pub root: NodeId,
    pub forward_adj: HashMap<NodeId, Vec<(NodeId, usize)>>,  // Skip serialization
    pub reverse_adj: HashMap<NodeId, Vec<(NodeId, usize)>>,  // Skip serialization
}
```

Methods: `add_node()`, `add_edge()`, `node()`, `node_count()`, `edge_count()`, `rebuild_adjacency()`

### CodeNode Methods

- `id()` - Returns the NodeId for any variant
- `children_mut()` - Returns a mutable reference to the children Vec for any variant

### SubGraph

Filtered view for rendering:

```rust
pub struct SubGraph {
    pub nodes: Vec<CodeNode>,
    pub edges: Vec<CodeEdge>,
    pub aggregated_edges: Vec<AggregatedEdge>,
}
```

## Parser Module

### Extractor

Main entry point for code analysis:

```rust
Extractor::extract_file(
    file_path: &str,
    source: &str,
    language: &Language,
) -> Result<(Vec<CodeNode>, Vec<RawReference>)>
```

Uses Tree-sitter to parse source and extract:
- Code block nodes (functions, classes, etc.)
- Raw references (imports, calls, type uses)

### Language-Specific Classification

**Python**
- `function_definition` → Function
- `class_definition` → Class
- Private if name starts with `_`

**TypeScript/JavaScript**
- `function_declaration`, `arrow_function` → Function
- `class_declaration` → Class
- `interface_declaration` → Interface
- `type_alias_declaration` → TypeAlias
- `enum_declaration` → Enum

**Rust**
- `function_item` → Function
- `struct_item` → Struct
- `enum_item` → Enum
- `trait_item` → Trait
- `impl_item` → Impl
- `mod_item` → Module
- Visibility from `visibility_modifier` presence

### RawReference

Unevaluated reference found during parsing:

```rust
pub struct RawReference {
    pub from_node: NodeId,
    pub kind: RawRefKind,
    pub name: String,
    pub span: Span,
}
```

Reference kinds: `Import`, `FunctionCall`, `MethodCall`, `TypeReference`, `Inheritance`, `TraitImpl`, `VariableUsage`

## Repository Module

### RepoScanner

```rust
RepoScanner::scan(root: &Path) -> CodeGraph
```

Walks directory tree respecting `.gitignore`:
- Creates Directory nodes for folders
- Creates File nodes with detected language
- Builds parent-child relationships

### clone_repo

```rust
clone_repo(url: &str, target_dir: &Path) -> PathBuf
```

Shallow clones GitHub/GitLab repositories (`--depth 1`).

## Resolver Module

### SymbolTable

Maps symbol names to node IDs:

```rust
SymbolTable::build_from_graph(graph) -> SymbolTable
SymbolTable::resolve_references(refs) -> Vec<CodeEdge>
```

Stores both simple names (`foo`) and qualified names (`path/file.rs::foo`).

`resolve_references` applies name normalization before symbol lookup:
- **FunctionCall/MethodCall**: strips method receiver (`foo.bar()` -> `bar`) and module path (`module::func` -> `func`)
- **TypeReference/Inheritance/TraitImpl**: strips generic parameters (`Foo<Bar>` -> `Foo`) and path prefix (`std::vec::Vec` -> `Vec`)
- Falls back to the original qualified name for type references if the simplified name doesn't match

### ImportResolver

Resolves import statements to file-level edges:
- Handles relative imports (`./`, `../`)
- Python dotted imports (`foo.bar.baz`)
- Rust crate imports (`crate::module::item`)
- Tries multiple extensions (`.ts`, `.tsx`, `.js`, `.py`, `.rs`)
- Creates file-to-file Import edges (separate from the symbol-level edges from `SymbolTable`)

## Typical Workflow

```rust
// 1. Scan repository
let graph = RepoScanner::scan(&path)?;

// 2. Parse each file
for file in graph.files() {
    let source = std::fs::read_to_string(&file.path)?;
    let (blocks, refs) = Extractor::extract_file(&file.path, &source, &file.language);
    // Add blocks to graph
}

// 3. Build symbol table
let symbols = SymbolTable::build_from_graph(&graph);

// 4. Resolve symbol references (with name normalization)
let edges = symbols.resolve_references(&all_refs);
// Add edges to graph

// 5. Resolve file-level import edges
let import_edges = ImportResolver::resolve(&graph, &all_refs);
// Add import edges to graph

// 6. Filter for rendering
let subgraph = SubGraph::from_graph(&graph, &visible_ids, &edge_kinds);
```

## Benchmarking

Criterion benchmark suite in `crates/cc-core/benches/`:

### graph_bench.rs

Graph operation benchmarks:
- `add_edge_unique` - Adding unique edges (100, 500, 1000, 5000 edges)
- `add_edge_all_duplicates` - Adding duplicate edges (merge path)
- `add_edge_mixed` - Realistic mix (~20% duplicates among 50 hot edges)
- `rebuild_adjacency` - Rebuilding forward/reverse adjacency indexes
- `subgraph_extraction` - SubGraph::from_graph with partial visibility

### parse_bench.rs

Parsing pipeline benchmarks:
- `extract_file` - Single file extraction per language (Python, TypeScript, Rust)
- `extract_many_files` - Sequential multi-file extraction (10, 50, 100 files)
- `full_pipeline` - End-to-end: parse → symbol table → resolve → add edges (20, 50 files)

Run with: `cargo bench -p cc-core`

## Dependencies

| Crate | Purpose |
|-------|---------|
| tree-sitter | AST parsing framework |
| tree-sitter-python | Python parser |
| tree-sitter-typescript | TS/JS parser |
| tree-sitter-rust | Rust parser |
| serde | Serialization |
| rayon | Parallel processing |
| ignore | Gitignore-aware walking |
| anyhow/thiserror | Error handling |

## Files

| File | Role | Key Exports |
|------|------|-------------|
| `crates/cc-core/src/lib.rs` | Crate root | Public module re-exports |
| `crates/cc-core/src/model/mod.rs` | Model module | Re-exports node, edge, graph types |
| `crates/cc-core/src/model/node.rs` | Node types | NodeId, CodeNode, BlockKind, Visibility, Language |
| `crates/cc-core/src/model/edge.rs` | Edge types | EdgeKind, CodeEdge, AggregatedEdge, RawReference, RawRefKind |
| `crates/cc-core/src/model/graph.rs` | Graph structure | CodeGraph, SubGraph |
| `crates/cc-core/src/parser/mod.rs` | Parser module | Re-exports Extractor |
| `crates/cc-core/src/parser/extract.rs` | Tree-sitter extraction | Extractor::extract_file |
| `crates/cc-core/src/repo/mod.rs` | Repo module | Re-exports scanner, clone |
| `crates/cc-core/src/repo/scanner.rs` | Directory walking | RepoScanner::scan |
| `crates/cc-core/src/repo/clone.rs` | Git cloning | clone_repo |
| `crates/cc-core/src/resolver/mod.rs` | Resolver module | Re-exports resolvers |
| `crates/cc-core/src/resolver/symbol_table.rs` | Symbol resolution | SymbolTable |
| `crates/cc-core/src/resolver/import_resolver.rs` | Import resolution | ImportResolver |
| `crates/cc-core/src/resolver/call_resolver.rs` | Call resolution | CallResolver |
| `crates/cc-core/src/resolver/type_resolver.rs` | Type resolution | TypeResolver |
| `crates/cc-core/benches/graph_bench.rs` | Graph benchmarks | Criterion benchmark group |
| `crates/cc-core/benches/parse_bench.rs` | Parse benchmarks | Criterion benchmark group |

## Invariants and Constraints

- NodeId format is stable: directories use path, files use path, code blocks use "path::name@line".
- CodeGraph adjacency indexes (forward_adj, reverse_adj) are skipped during JSON serialization and must be rebuilt after deserialization via `rebuild_adjacency()`.
- Duplicate edges (same source, target, kind) are merged by incrementing weight rather than creating a second edge.
- The Extractor is stateless — each `extract_file` call is independent and can be parallelized.
- RawReferences are intermediate — they must be resolved through the SymbolTable to produce CodeEdges.
- The SymbolTable maps both simple names ("foo") and qualified names ("path/file.rs::foo") to NodeIds.
- ImportResolver tries multiple file extensions when resolving import paths; resolution order matters for ambiguous cases.
- Tree-sitter parsers are language-specific; adding a new language requires a new tree-sitter grammar dependency and classification logic in the Extractor.
