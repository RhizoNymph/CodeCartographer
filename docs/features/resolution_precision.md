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
- Language-correct resolution in polyglot repos: an extension-less module path (`./util`, `mypkg.util`, `crate::util`) is answered only by files whose extension belongs to the **importing** file's language, so `util.py` / `util.ts` / `util.rs` never shadow each other.
- Rust use-path resolution (`crate::`, `super::`, `self::`): paths name modules and items rather than files, so the resolver probes progressively shorter prefixes against the source file's crate `src` root (workspace-aware) until a file (`.rs` / `mod.rs`, falling back to `lib.rs`/`main.rs`) matches. External-crate paths (`std::`, dependencies) do not resolve.
- Merging duplicate edges keeps the highest-confidence resolution.
- Frontend: dashed/dimmed rendering of ambiguous edges and a toolbar toggle to hide them.

**Not in scope:**
- Full semantic/type-directed name resolution (no scope analysis, no type inference).
- Genuine cross-language imports (wasm-bindgen, PyO3, codegen bridges). A known importing language is never allowed to resolve to another language's file; such an import simply produces no edge.
- Disambiguating ambiguous names beyond the same-file / imported-file tiers.
- Non-Python relative import syntaxes (TS/JS `./`, `../` are handled by the pre-existing generic branch).
- Recording the *symbols* named by `from x import Thing, other` (and mapping `as` aliases back to their original symbol). Import refs carry only the module path, so an import edge says "file A imports file B", never "A imports symbol S from B".
- Reading `sys.path`, `pyproject.toml`/`setup.cfg` package metadata, or installed site-packages. Roots are inferred from the scanned file set only; third-party and stdlib imports deliberately resolve to nothing.

## Data/Control Flow

Resolution runs inside `parse_repo` (`crates/cc-tauri/src/commands/parse.rs`) after all files are parsed and their `CodeBlock` nodes added to the graph:

1. **Import resolution first.** `ImportResolver::resolve(graph, refs)` builds a [`PathIndex`](#the-path-index) over every `File` node, then returns `(Vec<CodeEdge>, ImportMap)`:
   - For each `Import` raw reference it resolves the module path to a target file `NodeId` (extension probing + language-specific rules), scoped to the importing file's language.
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
- `graphStore.hideAmbiguousEdges` (default `false`) + `setHideAmbiguousEdges` bump `edgeVersion`, not `layoutVersion`: hiding ambiguous edges is a pure client-side edge filter, so it re-runs only the edge phase and leaves the node positions alone (unlike `setHideUnconnectedNodes`, which changes the node set). The Toolbar exposes a "Hide ambiguous" checkbox next to "Hide unconnected".
- The flag threads `Canvas.tsx -> PixiRenderer.updateGraph / updateEdges -> fetchViewEdges(..., hideAmbiguousEdges)`, where both the direct-edge filter (`kindFilteredEdges`) and the aggregated-edge filter (`computeAggregatedEdges`) drop `resolution === "Ambiguous"` edges.

### The path index

`resolver/path_index.rs` owns the only mapping from paths to file `NodeId`s used
during import resolution. It is built once per `ImportResolver::resolve` call and
holds **full repository-relative paths only** (`shared/util.ts`). It exposes
three queries and no raw map:

| Query | Meaning |
|-------|---------|
| `PathIndex::exact(path)` | is there a file at exactly this path, extension included? |
| `PathIndex::probe(base, language)` | extension probing for one language (`probe_path`), nothing else |
| `PathIndex::resolve(base, language)` | `exact`, then `probe` for `Some(language)` / `probe_path_all` for `None` |

`PathIndex::file_paths()` additionally exposes the raw scanned path list, which
is what `PythonPackageRoots::from_file_paths` consumes.

Every lookup in `import_resolver.rs` goes through one of those three, so an
extension-less module path can never be answered without naming the language
that is asking. That is what makes polyglot resolution correct (below) and it
keeps *one* definition of "which extension wins", in `extension_probe.rs`.

### Cross-language collisions (polyglot repos)

`shared/util.py`, `shared/util.ts` and `shared/util.rs` all name the module path
`shared/util`. Nothing about the *target* says which is meant -- only the
importing file's language does.

The index therefore stores no extension-stripped keys at all. `./util` from a
TypeScript file is resolved by probing `TS_JS_EXTENSIONS` against full paths and
lands on `util.ts`; the same import from a Python file probes
`PYTHON_EXTENSIONS` and lands on `util.py`; `crate::util` probes
`RUST_EXTENSIONS` and lands on `util.rs`. A known language never falls back to
another language's extensions, so a TypeScript import of a module that only
exists as `.py` yields **no edge** rather than a wrong one.

This replaced an earlier scheme in which the path map also held
extension-stripped keys (`shared/util`) with a `stripped_key_rank` tie-break.
That key was consulted *before* language-aware probing, so whichever file won
the collision won every import of that path regardless of language -- and the
rank (which only demoted `.pyi`) even let `util.ts` beat `util.pyi`. Making the
rank deterministic made the wrong answer stable, not right. The stripped key was
a second, language-blind implementation of extension probing; removing it is
lossless because every language's stripped key is reachable by probing that
language's own extension list against the full paths.

When the importing file's language is unknown, `probe_path_all` is used: a fixed
extension order, so the outcome is deterministic without being language-aware.

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

`.pyi` maps to `Language::Python` (`model/node.rs`), so stubs are scanned, parsed, and resolvable. A real module always beats its stub because `PYTHON_EXTENSIONS` probes `.py`, `/__init__.py`, `.pyi`, `/__init__.pyi` **in that order**, and after the path-index change probe order is the only place extension preference is expressed (there is no longer a second, rank-based ordering to keep in sync). A stub is still a valid target when no real module exists: stub-only modules resolve to the `.pyi`.

## Files

| File | Role | Key exports/interfaces |
|------|------|------------------------|
| `crates/cc-core/src/model/edge.rs` | Edge model | `Resolution` enum (ordered worst->best), `CodeEdge { resolution }`, `CodeEdge::new(..)` |
| `crates/cc-core/src/model/graph.rs` | Graph + merge | `CodeGraph::add_edge` keeps max resolution on merge |
| `crates/cc-core/src/resolver/import_resolver.rs` | Import resolution | `ImportResolver::resolve -> (Vec<CodeEdge>, ImportMap)`, `ImportMap`, `resolve_import_path`, `resolve_python_relative`, `resolve_python_absolute`, `resolve_rust_use_path` |
| `crates/cc-core/src/resolver/path_index.rs` | Language-aware path lookup | `PathIndex::from_graph`, `exact`, `probe`, `resolve(base, Option<&Language>)`, `file_paths` |
| `crates/cc-core/src/resolver/python_roots.rs` | Python package-root detection | `PythonPackageRoots::from_file_paths`, `roots`, `ordered_for` |
| `crates/cc-core/src/resolver/symbol_table.rs` | Precision ladder | `SymbolTable { by_file, node_to_file }`, `resolve_references(refs, imports)`, `resolve_via_ladder`, `MAX_AMBIGUOUS_CANDIDATES` |
| `crates/cc-core/src/resolver/extension_probe.rs` | Extension probing | `probe_path` (Python probes `.py`, `/__init__.py`, `.pyi`, `/__init__.pyi` in that order) |
| `crates/cc-core/src/repo/scanner.rs` | Scanning + ignore rules | `RepoScanner::scan`, `DirIgnoreRule`, `dir_ignore_rule` |
| `crates/cc-core/src/model/node.rs` | Language mapping | `Language::from_extension` (`py`, `pyi` -> Python) |
| `crates/cc-core/tests/fixtures/python_src_layout/` | On-disk fixture | src layout + subpackage + `tests/` + `.pyi` stub + `venv/`/`__pycache__/`/`build/` decoys |
| `crates/cc-core/tests/python_seam_test.rs` | Extraction/resolution seam | Pins the two halves together on aliased, multi-name, star and bare-package imports; fails if either half regresses |
| `crates/cc-core/tests/python_resolution_test.rs` | End-to-end test | scan -> parse -> `ImportResolver::resolve` over the fixture |
| `crates/cc-core/tests/polyglot_resolution_test.rs` | Cross-language test | in-memory graphs where the same stem exists as `.py`/`.ts`/`.js`/`.rs`; asserts each language reaches its own file, `.pyi` still loses to `.py`, and single-language repos are unchanged |
| `crates/cc-core/tests/extension_probe_test.rs` | Probe order test | pins `probe_path` per language, incl. `.py` before `.pyi` |
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
- A `.pyi` stub must never shadow the module it stubs. One place enforces this now: the `PYTHON_EXTENSIONS` probe order in `extension_probe.rs`. Do not add a second ordering elsewhere -- the previous `stripped_key_rank` duplicate is exactly what let `util.ts` beat `util.pyi`.
- `PathIndex` holds **full paths only**. Never re-introduce extension-stripped keys: a key like `shared/util` cannot say whether it means `util.py`, `util.ts` or `util.rs`, and whichever file wins the collision wins it for every language.
- Extension preference lives in exactly one place, `extension_probe.rs`. `PathIndex` delegates to `probe_path` / `probe_path_all`; every extension-less lookup in `import_resolver.rs` goes through `PathIndex`.
- A known importing language never falls back to another language's extensions. `PathIndex::resolve(base, Some(lang))` probes `lang`'s extensions and stops; no edge is preferable to a cross-language edge.
- An unknown importing language (`None`) uses `probe_path_all`, whose extension order is a fixed constant, so resolution stays deterministic across runs even though the underlying map is a `HashMap`.
- Scanner ignore rules match **directory names only**. `DirIgnoreRule::Always` names are dropped unconditionally; `DirIgnoreRule::UnlessPythonPackage` names (`build`, `dist`) are dropped only when the directory has no `__init__.py`/`__init__.pyi`, so a genuine package named `build` survives. The scan root itself (depth 0) is never filtered.
