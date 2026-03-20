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
) -> (Vec<CodeNode>, Vec<RawReference>)
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

### ImportResolver

Resolves import statements to target files:
- Handles relative imports (`./`, `../`)
- Python dotted imports (`foo.bar.baz`)
- Rust crate imports (`crate::module::item`)
- Tries multiple extensions (`.ts`, `.tsx`, `.js`, `.py`, `.rs`)

### CallResolver

Resolves function/method calls to definitions:
- Strips method receiver: `foo.bar()` → `bar`
- Strips module path: `module::func` → `func`
- Looks up in SymbolTable

### TypeResolver

Resolves type references, inheritance, trait implementations:
- Strips generic parameters: `Foo<Bar>` → `Foo`
- Strips path prefix: `std::vec::Vec` → `Vec`

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

// 4. Resolve references
let edges = symbols.resolve_references(&all_refs);
// Add edges to graph

// 5. Filter for rendering
let subgraph = SubGraph::from_graph(&graph, &visible_ids, &edge_kinds);
```

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
