# Benchmarking

Criterion-based performance benchmarks for the cc-core crate, covering graph operations and the parsing pipeline.

## Scope

**In scope:**
- Graph mutation performance (add_edge with unique, duplicate, and mixed edge sets)
- Adjacency index rebuild performance
- SubGraph extraction performance
- Tree-sitter parsing throughput per language (Python, TypeScript, Rust)
- Multi-file sequential parsing throughput
- Full pipeline benchmarks (parse → symbol table → resolve → add edges)

**Not in scope:**
- Frontend rendering performance
- IPC serialization overhead
- ELK.js layout performance
- End-to-end application benchmarks

## Benchmark Suites

### graph_bench.rs

Measures core graph data structure operations.

**add_edge_unique** — Inserts N unique edges into an empty graph. Tests the worst case for any linear duplicate scan since no edge is ever a duplicate. Sizes: 100, 500, 1000, 5000.

**add_edge_all_duplicates** — Inserts N edges with the same (source, target, kind). Every insert after the first hits the duplicate-merge path (weight increment). Sizes: 100, 500, 1000, 5000.

**add_edge_mixed** — Inserts N edges with ~20% being duplicates of 50 "hot" edges, simulating a real codebase where popular functions are called from many sites. Sizes: 500, 1000, 5000.

**rebuild_adjacency** — Rebuilds forward and reverse adjacency indexes from edge list on a pre-populated graph. Sizes: 500, 1000, 5000.

**subgraph_extraction** — Calls SubGraph::from_graph with half the nodes visible and all edge kinds enabled. Measures filtering and edge collection. Graph sizes: 500, 2000 nodes.

### parse_bench.rs

Measures Tree-sitter parsing and the full code analysis pipeline.

**extract_file (single)** — Parses a single representative source file per language through Extractor::extract_file. Tests: test.py (~60 lines), test.ts (~140 lines), test.rs (~240 lines).

**extract_many_files** — Parses N files sequentially, cycling through Python/TypeScript/Rust. Measures throughput for the file iteration hot path. Sizes: 10, 50, 100 files.

**full_pipeline** — End-to-end benchmark: creates file nodes, parses all files, builds SymbolTable, resolves all references into edges, and adds edges to the graph. Sizes: 20, 50 files.

## Data Flow

```
cargo bench -p cc-core
    ↓
Criterion harness
    ↓
graph_bench.rs                          parse_bench.rs
├── CodeGraph::add_edge()               ├── Extractor::extract_file()
├── CodeGraph::rebuild_adjacency()      ├── Sequential multi-file parsing
└── SubGraph::from_graph()              └── Full pipeline:
                                            parse → SymbolTable::build_from_graph()
                                                  → resolve_references()
                                                  → add_edge()
```

## Running

```bash
# Run all cc-core benchmarks
cargo bench -p cc-core

# Run a specific benchmark group
cargo bench -p cc-core -- add_edge_unique
cargo bench -p cc-core -- extract_file
cargo bench -p cc-core -- full_pipeline

# Generate HTML report (output in target/criterion/)
cargo bench -p cc-core
# Then open target/criterion/report/index.html
```

## Files

| File | Role | Key Exports |
|------|------|-------------|
| `crates/cc-core/benches/graph_bench.rs` | Graph operation benchmarks | criterion benchmark group: add_edge_*, rebuild_adjacency, subgraph_extraction |
| `crates/cc-core/benches/parse_bench.rs` | Parsing pipeline benchmarks | criterion benchmark group: extract_file, extract_many_files, full_pipeline |

## Invariants and Constraints

- Benchmarks use synthetic data (inline source strings, generated node/edge IDs) — they do not read from disk.
- The parse_bench source snippets are sized to be representative but small enough to keep iteration time reasonable.
- full_pipeline benchmark exercises the actual SymbolTable and resolution code paths, not mocks.
- Benchmark results are stored in `target/criterion/` and can be compared across runs by Criterion automatically.
- Adding a new language requires adding a corresponding source snippet constant and benchmark case in parse_bench.rs.
