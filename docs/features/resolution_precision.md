# Resolution Precision Feature

## Scope

**In scope:**
- Resolving each raw reference to the highest-confidence target via a precision ladder.
- Tagging every `CodeEdge` with a `Resolution` confidence (`SameFile`, `Imported`, `GlobalUnique`, `Ambiguous`).
- Capping ambiguous fan-out: 2..=5 candidate names produce one flagged edge each; more than 5 are dropped entirely.
- Producing an import map (source file -> imported files) from the import resolver and feeding it to the symbol resolver as the "imported" tier.
- Python leading-dot relative import resolution (`.foo`, `..pkg.mod`, `from . import x` / `.`), including package `__init__.py` targets.
- Python absolute import resolution (`import pkg.sub.mod`, `import pkg`, `import module`) against detected **package roots**, so `src/` layouts, monorepo `packages/*/` layouts, and sibling `tests/` trees all resolve.
- Python `.pyi` type stubs as resolution targets, always ranked behind the real module they stub.
- Rust use-path resolution (`crate::`, `super::`, `self::`): paths name modules and items rather than files, so the resolver probes progressively shorter prefixes against the source file's crate `src` root (workspace-aware) until a file (`.rs` / `mod.rs`, falling back to `lib.rs`/`main.rs`) matches. External-crate paths (`std::`, dependencies) do not resolve.
- Merging duplicate edges keeps the highest-confidence resolution.
- Frontend: dashed/dimmed rendering of ambiguous edges and a toolbar toggle to hide them.

**Not in scope:**
- Full semantic/type-directed name resolution (no scope analysis, no type inference).
- Disambiguating ambiguous names beyond the same-file / imported-file tiers.
- Non-Python relative import syntaxes (TS/JS `./`, `../` are handled by the pre-existing generic branch).
- Recording the *symbols* named by `from x import Thing, other` (and mapping `as` aliases back to their original symbol). Import refs carry only the module path, so an import edge says "file A imports file B", never "A imports symbol S from B".
- Reading `sys.path`, `pyproject.toml`/`setup.cfg` package metadata, or installed site-packages. Roots are inferred from the scanned file set only; third-party and stdlib imports deliberately resolve to nothing.

## Data/Control Flow

Resolution runs inside `parse_repo` (`crates/cc-tauri/src/commands/parse.rs`) after all files are parsed and their `CodeBlock` nodes added to the graph:

1. **Import resolution first.** `ImportResolver::resolve(graph, refs)` returns `(Vec<CodeEdge>, ImportMap)`:
   - For each `Import` raw reference it resolves the module path to a target file `NodeId` (extension probing + language-specific rules).
   - Emits a file-to-file `Import` edge with `Resolution::Imported` (import edges are exact by construction — an edge is only emitted when a concrete target file is found).
   - Records `source_file_path -> {imported_file_path,...}` in the `ImportMap`.
   - The import edges are added to the graph; the map is passed to the symbol resolver.
2. **Symbol table build.** `SymbolTable::build_from_graph(graph)` indexes, for every `CodeBlock`:
   - `symbols`: `name -> [NodeId]` and `file_path::name -> [NodeId]` (FQN).
   - `by_file`: `file_path -> name -> [NodeId]` (for the same-file and imported-file tiers).
   - `node_to_file`: `NodeId -> file_path` for every `CodeBlock` **and** `File` node, so a reference's `from_node` can be mapped to its source file whether it is a top-level import attributed to the File or a nested block.
3. **Reference resolution via the ladder.** `SymbolTable::resolve_references(refs, import_map)` normalizes each reference name (strips receiver/path/generics — unchanged from before), skips self-edges, and for type-like refs first tries an exact FQN match (unambiguous -> `GlobalUnique`). Otherwise it applies `resolve_via_ladder`:
   1. **Same file** — a match in the source file's own `by_file` bucket -> `Resolution::SameFile`.
   2. **Imported file** — a match in any file the source imports (via `import_map`) -> `Resolution::Imported`.
   3. **Single global match** — exactly one distinct non-self `symbols` entry -> `Resolution::GlobalUnique`.
   4. **2..=5 global matches** — one edge per candidate, each `Resolution::Ambiguous`.
   5. **more than 5 global matches** — dropped (too noisy).
   The first tier that yields at least one edge wins; lower tiers are not consulted.
4. **Edge merge.** `CodeGraph::add_edge` merges duplicate `(source, target, kind)` triples: it sums weights and keeps the **max** resolution (`Ord` on `Resolution` is worst->best, so `max` = most confident).
5. **Serialization.** `resolution` is a field on `CodeEdge` (serde). Rust unit-variant enums serialize to their plain variant name, so the frontend receives `"SameFile" | "Imported" | "GlobalUnique" | "Ambiguous"`.

### Frontend flow

- `CodeEdge.resolution` (types.ts) flows through `elkLayout.ts` (`LayoutEdge.resolution`) into `EdgeDatum.resolution` (renderers/types.ts) in `EdgeDrawingManager.buildEdgeData`.
- `edgeDrawing.ts` renders edges with `resolution === "Ambiguous"` using `drawDashedPolyline` and a reduced alpha (`AMBIGUOUS_ALPHA_MULTIPLIER`).
- `graphStore.hideAmbiguousEdges` (default `false`) + `setHideAmbiguousEdges` bump `layoutVersion` (mirroring `setHideUnconnectedNodes`). The Toolbar exposes a "Hide ambiguous" checkbox next to "Hide unconnected".
- The flag threads `Canvas.tsx -> PixiRenderer.updateGraph -> layoutGraph(..., hideAmbiguousEdges)`, where both the direct-edge filter (`kindFilteredEdges`) and the aggregated-edge filter (`computeAggregatedEdges`) drop `resolution === "Ambiguous"` edges.

### Python relative imports

`ImportResolver::resolve_python_relative` runs (for Python source only) before the generic `starts_with('.')` branch:
- Counts leading dots: 1 dot = the source file's package directory; each extra dot walks one parent directory up.
- Converts the dotted remainder to a path segment, joins onto the base dir, normalizes, and probes `<path>.py`, `<path>/__init__.py`, then the `.pyi` stub forms (via `probe_path` with `Language::Python`).
- A bare `.`/`..` (as in `from . import x`, module path `.`) resolves to the base directory's `__init__.py`.

### Python absolute imports and package roots

Python's runtime resolution of `import mypkg.mod` searches `sys.path`. A static scan has no `sys.path`, so `resolver/python_roots.rs` reconstructs a plausible candidate set from the scanned file paths alone (`PythonPackageRoots::from_file_paths`):

1. The repository root (`""`) is always a candidate.
2. Every directory literally named `src` is a candidate (`src` is never itself an importable package).
3. For every *package* directory (containing `__init__.py` or `__init__.pyi`), walk up while the parent is also a package; the **parent of the topmost package** in that unbroken chain is a candidate. This is what makes monorepo `packages/<name>/<name>/__init__.py` layouts yield `packages/<name>` as a root.

`PythonPackageRoots::ordered_for(from_file)` then orders the candidates per importing file: roots that contain the importing file first (deepest first), then the rest (deepest first), lexicographic tie-break. `ImportResolver::resolve_python_absolute` converts the dotted module path to `a/b/c` and, for each root in that order, tries an exact path-map hit and then `probe_path(.., Language::Python, ..)`. The first hit wins; nothing matching means no edge (stdlib/third-party).

This branch runs for **all** Python absolute imports — dotted (`pkg.sub.mod`) and bare (`pkg`, `module`) alike — replacing the previous repo-root-only dotted probe and the bare exact-match lookup.

### `.pyi` stubs

`.pyi` maps to `Language::Python` (`model/node.rs`), so stubs are scanned, parsed, and resolvable. Ordering guarantees a real module always beats its stub:
- `PYTHON_EXTENSIONS` probes `.py`, `/__init__.py`, `.pyi`, `/__init__.pyi` in that order.
- `path_to_id` also holds extension-stripped keys, and `pkg/mod.py` / `pkg/mod.pyi` collide on `pkg/mod`. `stripped_key_rank` ranks `.pyi` below everything else, so the winner is chosen by rank rather than by `HashMap` iteration order.

## Files

| File | Role | Key exports/interfaces |
|------|------|------------------------|
| `crates/cc-core/src/model/edge.rs` | Edge model | `Resolution` enum (ordered worst->best), `CodeEdge { resolution }`, `CodeEdge::new(..)` |
| `crates/cc-core/src/model/graph.rs` | Graph + merge | `CodeGraph::add_edge` keeps max resolution on merge |
| `crates/cc-core/src/resolver/import_resolver.rs` | Import resolution | `ImportResolver::resolve -> (Vec<CodeEdge>, ImportMap)`, `ImportMap`, `resolve_python_relative`, `resolve_python_absolute`, `stripped_key_rank` |
| `crates/cc-core/src/resolver/python_roots.rs` | Python package-root detection | `PythonPackageRoots::from_file_paths`, `roots`, `ordered_for` |
| `crates/cc-core/src/resolver/symbol_table.rs` | Precision ladder | `SymbolTable { by_file, node_to_file }`, `resolve_references(refs, imports)`, `resolve_via_ladder`, `MAX_AMBIGUOUS_CANDIDATES` |
| `crates/cc-core/src/resolver/extension_probe.rs` | Extension probing | `probe_path` (Python probes `.py`, `/__init__.py`, `.pyi`, `/__init__.pyi` in that order) |
| `crates/cc-core/src/repo/scanner.rs` | Scanning + ignore rules | `RepoScanner::scan`, `DirIgnoreRule`, `dir_ignore_rule` |
| `crates/cc-core/src/model/node.rs` | Language mapping | `Language::from_extension` (`py`, `pyi` -> Python) |
| `crates/cc-core/tests/fixtures/python_src_layout/` | On-disk fixture | src layout + subpackage + `tests/` + `.pyi` stub + `venv/`/`__pycache__/`/`build/` decoys |
| `crates/cc-core/tests/python_resolution_test.rs` | End-to-end test | scan -> parse -> `ImportResolver::resolve` over the fixture |
| `crates/cc-tauri/src/commands/parse.rs` | Orchestration | imports resolved before symbol references; passes `import_map` |
| `packages/app/src/api/types.ts` | FE types | `Resolution` union, `CodeEdge.resolution` |
| `packages/app/src/canvas/layout/elkLayout.ts` | Layout + filter | `LayoutEdge.resolution`, `hideAmbiguousEdges` param |
| `packages/app/src/canvas/renderers/edgeDrawing.ts` | Rendering | `drawDashedPolyline`, `AMBIGUOUS_ALPHA_MULTIPLIER`, dashed/dimmed ambiguous edges |
| `packages/app/src/canvas/renderers/types.ts` | FE renderer types | `EdgeDatum.resolution` |
| `packages/app/src/stores/graphStore.ts` | State | `hideAmbiguousEdges`, `setHideAmbiguousEdges` |
| `packages/app/src/toolbar/Toolbar.tsx` | UI | "Hide ambiguous" toggle |
| `packages/app/src/canvas/Canvas.tsx`, `PixiRenderer.ts` | Threading | pass `hideAmbiguousEdges` to `layoutGraph` |

## Invariants and Constraints

- `Resolution` variants are ordered worst->best (`Ambiguous < GlobalUnique < Imported < SameFile`); the derived `Ord` is used both for the merge (`max`) and as a confidence comparison. Do not reorder.
- Import edges are always `Resolution::Imported` — the resolver only emits them for concrete resolved targets.
- Only the first ladder tier that produces at least one edge is used; a same-file match suppresses imported/global tiers for that reference.
- The ambiguity cap is exactly 5 (`MAX_AMBIGUOUS_CANDIDATES`): 2..=5 distinct non-self global matches produce one `Ambiguous` edge each; more than 5 produce none.
- Self-edges (`target == from_node`) are never emitted.
- `node_to_file` must map both `CodeBlock` and `File` node ids, because a reference's `from_node` may be either after top-level imports are attributed to the File.
- The serde form of `Resolution` is the plain variant name; the frontend `Resolution` union must match it exactly.
- Aggregated (collapsed-container) edges have `resolution === null` and are always drawn solid; only direct edges can be ambiguous/dashed.
- Python leading-dot handling must run before the generic `./`-style branch and only for Python source.
- `RawRefKind::Import { module_path }` for Python is the clean dotted module path exactly as written in source, with any `as` alias clause stripped and imported symbol names excluded; one ref per imported module. The resolver relies on this shape (`"os"`, `"numpy"`, `"a.b.c"`, `"mypkg.mod"`, `".rel"`, `"."`, `"..pkg.sub"`).
- The repo root (`""`) is always a Python package root, so flat layouts keep resolving without any `__init__.py` present.
- `PythonPackageRoots` ordering must be total and deterministic; resolution takes the **first** root that produces a hit, so ordering is semantics, not an optimisation.
- Root detection never inspects the filesystem — it is a pure function of the scanned file path set, so it stays correct for graphs built in memory (tests) and for cloned repos alike.
- A `.pyi` stub must never shadow the module it stubs. Two places enforce this: the `PYTHON_EXTENSIONS` probe order and `stripped_key_rank` in the path map.
- Scanner ignore rules match **directory names only**. `DirIgnoreRule::Always` names are dropped unconditionally; `DirIgnoreRule::UnlessPythonPackage` names (`build`, `dist`) are dropped only when the directory has no `__init__.py`/`__init__.pyi`, so a genuine package named `build` survives. The scan root itself (depth 0) is never filtered.
