# Benchmarking

## Scope

Everything needed to answer "is this branch faster, and by how much" with a
number rather than an argument:

- **Criterion microbenchmarks** over cc-core's hot functions, on fixtures shaped
  like the data the app actually holds.
- **An end-to-end harness** that runs the whole backend pipeline plus the query
  battery the UI issues, and prints one JSON object of timings and graph stats.
- **A synthetic repo generator** so both sides of a comparison see byte-identical
  input at a chosen size and ambiguity level.
- **A frontend routing benchmark** for the canvas redraw's edge-routing pass.
- **A runner** that drives all four in one pass, and **a CI workflow** that
  produces the same artifacts on demand.

## Non-scope

- **No pass/fail gate anywhere.** Nothing in this feature fails a build on a
  timing. CI runs on shared, noisy hardware where a threshold would either fire
  on noise or catch nothing; see the comment at the top of
  `.github/workflows/bench.yml`.
- **No historical tracking.** There is no time-series database and no
  "compare against the last run on main" step. A comparison is two runs on ONE
  machine, back to back, by a human who wants an answer.
- **Not correctness.** Benches are not tests: they assert nothing, and
  `cargo test -p cc-core` does not run them. Fixtures here may be changed freely
  when they measure the wrong thing (and one of them did -- see below).
- **Not the Tauri IPC boundary.** The harness measures cc-core, including
  building and serializing the parse payload, but not Tauri's own transport.

## Layers

### 1. Criterion benches -- `crates/cc-core/benches/`

| File | Groups |
| --- | --- |
| `graph_bench.rs` | `add_edge_*`, `rebuild_adjacency`, `subgraph_flat_no_hierarchy`, `subgraph_nested_collapsed`, `subgraph_fully_expanded`, `neighborhood_bfs`, `parse_result_serialize` |
| `parse_bench.rs` | `extract_file`, `extract_many_files`, `full_pipeline`, `resolve_hub_ambiguity` |
| `common/mod.rs` | shared fixtures: `nested_graph`, `flat_graph`, seeded `Rng`, `all_edge_kinds` |

```bash
cargo bench -p cc-core                       # full suite, default sampling
cargo bench -p cc-core -- --quick            # smoke check that everything runs
cargo bench -p cc-core --bench graph_bench -- subgraph_nested   # one group
cargo bench -p cc-core -- --warm-up-time 1 --measurement-time 3 --sample-size 20
```

`common/mod.rs` lives in a subdirectory because cargo auto-discovers
`benches/*.rs` as bench targets; a top-level `common.rs` would be compiled as a
bench with no `main`.

cc-core sets `[lib] bench = false`. Without it cargo builds a libtest bench
harness for the lib (which contains no `#[bench]` functions) and runs it FIRST,
and that harness rejects criterion's CLI flags -- so `cargo bench -p cc-core --
--sample-size 20` failed before reaching a benchmark. A baseline checkout
predating that line needs it copied in along with the bench files.

#### The fixture trap this layer exists to avoid

The original `bench_subgraph_extraction` built N flat `File` nodes with empty
`children` arrays and ran `SubGraph::from_graph` over half of them. That graph
has an EMPTY child -> parent map, so `find_render_ancestor` returned on its first
probe and the aggregation path -- the only reason `SubGraph::from_graph` needs a
parent map at all -- never executed. It measured precisely the input for which
the parent map is irrelevant, and would have reported "no change" for any amount
of work saved building or reusing it.

`common::nested_graph` builds `Directory > File > CodeBlock > CodeBlock` trees
(5 directory levels, 3-way fanout, 5 classes per file with 2 methods each) and
puts every edge between two LEAF blocks. The benches then render with containers
COLLAPSED, so both endpoints of every edge walk a real ancestor chain. The flat
case is kept as `subgraph_flat_no_hierarchy` -- renamed to say what it is, a
floor rather than a representative case.

When adding a bench, ask what shape of input makes the code under test do its
work, and build THAT. A fixture that skips the hot path is worse than no bench:
it reports a confident zero.

### 2. End-to-end harness -- `crates/cc-core/examples/perf_harness.rs`

The most representative number in the suite. Runs scan -> parse -> resolve
(mirroring `cc_tauri::commands::parse_repo` phase for phase, minus IPC), then:

- builds and serializes the parse payload, reporting bytes and time;
- runs `SubGraph::from_graph` over four render sets, from `directories_only`
  (everything collapsed, maximum lifting) to `fully_expanded` (no lifting);
- runs 200 `neighborhood` queries at depth 2;
- runs 50 `edge_detail` drill-ins on the collapsed view's aggregated edges.

```bash
cargo run --release --example perf_harness -- --repo /path/to/repo --label main
```

Flags: `--repo` (required), `--label`, `--seed`, `--subgraph-reps`,
`--neighborhood-queries`, `--edge-detail-queries`, `--out FILE`,
`--dump-payload FILE`. JSON goes to stdout, progress to stderr.

`--dump-payload` writes the serialized `ParseResult` itself, for answering "what
is the payload MADE of" rather than just how big it is. Measuring per-field byte
shares that way is what showed `signature` to be the fifth-largest contributor,
not the first (see `benchmarks/RESULTS.md`).

Two properties are load-bearing and must be preserved:

- **It compiles unchanged on every branch being compared.** It uses only the
  cc-core public API that is identical across them, and never names
  `ParseResult` as a type (it is owned on `main`, borrowing on the perf branch --
  the call is the same, which is exactly what makes the difference measurable).
  It does not reference `build_parent_map` (main-only) or `CodeGraph::parent_map`
  (perf-branch-only).
- **Its workload is deterministic.** Every choice -- render-set membership, focus
  nodes, drilled edges -- comes from a sorted id list indexed by a seeded
  SplitMix64 stream. Nothing depends on `HashMap` iteration order, which is
  randomized per process. A delta between runs is a delta in cost, not workload.

Each measurement reports `first_ms` and `steady_mean_ms` separately. On a branch
that caches derived state on the graph, the first call pays for the cache and the
rest do not; averaging them together would hide both facts.

### 3. Synthetic repo generator -- `benchmarks/gen_repo.py`

```bash
python3 benchmarks/gen_repo.py --preset medium --out "$TMPDIR/cc-bench-medium" --force
python3 benchmarks/gen_repo.py --files 500 --depth 3 --hub-fraction 0.8 --out /tmp/hubby
```

Presets: `small` (200 modules), `medium` (2000), `large` (10000). Everything is
driven by one seeded `random.Random`, so a given
(seed, files, depth, hub-fraction, ts-fraction) tuple always produces the same
tree -- which is what lets two checkouts be fed identical input.

`--hub-fraction` is the knob that matters most for the resolver: it sets the
share of modules defining the SAME names (`get`, `run`, `new`, `__init__`, ...).
Non-hub modules call those names without defining them, so their references fall
through to the global tiers where hundreds of candidates match. At `0.0` every
symbol is unique and resolution is trivially cheap.

`--out` is required and there is no default: generated trees never land inside
the repository.

### 4. Frontend routing bench -- `packages/app/benchmarks/edgeRouting.bench.ts`

```bash
cd packages/app
node benchmarks/edgeRouting.bench.ts
node benchmarks/edgeRouting.bench.ts --sizes 300x200,1500x1200 --reps 5 --json out.json
```

Deliberately NOT matched by the `tests/*.test.ts` glob: it is a stopwatch, not an
assertion, and it takes minutes at the larger sizes.

Three scenarios per size:

| Scenario | What it is | Comparable across branches? |
| --- | --- | --- |
| `full_scan_routing` | obstacles collected per edge by scanning every node, then routed crossing-aware | Yes -- reimplemented inside the bench, so identical everywhere. Should come out EQUAL; a gap means the environments differ and the other numbers are suspect. |
| `indexed_routing` | obstacles indexed once per redraw, queried per edge via `obstacleIndex.ts` | Only where that module exists; reported as `skipped` otherwise |
| `shipped_redraw` | what this branch actually does at this size, budget gate included | Yes -- this is the user-visible number |

The script degrades gracefully: `obstacleIndex.ts` and `edgeRoutingBudget.ts` are
loaded through a `try`/`catch` dynamic import, and their absence turns
`shipped_redraw` into "route everything, crossing-aware", which is the older
shipped behaviour. `edgeRoutingBudget.ts` is probed at BOTH
`src/canvas/layout/` (where it lives) and `src/canvas/renderers/` (where it lived
before the routing pipeline was consolidated), so a run on an older branch still
finds it and stays comparable. Runtime imports use explicit `.ts` specifiers so
the module chain loads under plain `node` (tsconfig sets
`allowImportingTsExtensions`).

`OBSTACLE_QUERY_MARGIN` is deliberately a LITERAL in the bench rather than an
import from `layout/routingConstants.ts`: the file has to stay byte-comparable
across branches where that module does not exist.

### 5. Runner -- `benchmarks/run_all.sh`

```bash
benchmarks/run_all.sh <label> <output-dir> <synthetic-repos-dir> [real-repo-path]
```

Runs all four layers with fixed, uniform parameters and drops the raw output in
one directory. The point is that the SAME commands run on both sides of a
comparison; anything conditional belongs elsewhere.

### 6. CI -- `.github/workflows/bench.yml`

`workflow_dispatch` (with a size input), or a PR labelled `bench`. Builds the
harness, generates a synthetic repo, runs the harness and a reduced-sampling
criterion pass plus the frontend bench, and uploads everything as an artifact.
No thresholds, by design.

## Comparing two branches

Results from one such comparison are recorded in `benchmarks/RESULTS.md`.

1. **One machine, sequential runs.** Never compare a number from one machine
   against a number from another, and never run the two passes concurrently.
2. **Second checkout for the baseline.** `git worktree add --detach <path> origin/main`.
3. **Copy the harness, generator, runner and frontend bench into the baseline
   checkout UNCOMMITTED.** They are branch-independent by construction; copying
   them in is what makes the older branch measurable at all.
4. **Generate the synthetic repos once**, outside both checkouts, and point both
   runs at them. Same for the real-repo case: pass the SAME `[real-repo-path]` to
   both runs, or the two passes will be reading different source trees.
5. **Run `benchmarks/run_all.sh` in each checkout** with different labels and
   output directories.
6. **State the build profile for each side.** `cargo bench` inherits from
   `[profile.release]`, which branches can and do change. If one side has LTO
   configured and the other does not, that asymmetry is real shipping behaviour
   and should be reported as such -- but to separate an ALGORITHMIC win from a
   build-flag win, re-run the faster side with the other's flags:

   ```bash
   CARGO_PROFILE_BENCH_LTO=false CARGO_PROFILE_BENCH_CODEGEN_UNITS=16 \
     cargo bench -p cc-core -- --sample-size 20
   ```

7. **Report deltas as percentages with the absolute numbers next to them**, and
   say how many samples each came from.

## Files

| Path | Role |
| --- | --- |
| `crates/cc-core/benches/common/mod.rs` | Shared fixtures. Exports `nested_graph`, `flat_graph`, `NestedGraph` (with `render_dirs` / `render_dirs_files` / `render_all`), `Rng`, `all_edge_kinds` |
| `crates/cc-core/benches/graph_bench.rs` | Graph-model criterion benches |
| `crates/cc-core/benches/parse_bench.rs` | Parser + resolver criterion benches, incl. `hub_ambiguity_fixture` |
| `crates/cc-core/examples/perf_harness.rs` | End-to-end harness binary |
| `benchmarks/gen_repo.py` | Synthetic repo generator |
| `benchmarks/run_all.sh` | One-pass runner over every layer |
| `benchmarks/RESULTS.md` | Recorded main-vs-branch comparison |
| `packages/app/benchmarks/edgeRouting.bench.ts` | Canvas edge-routing benchmark |
| `.github/workflows/bench.yml` | On-demand CI artifact producer |

## Invariants and constraints

- **The harness compiles on every branch under comparison.** Adding an API that
  only exists on one of them breaks the comparison, not just the build. If a
  needed signature genuinely diverges, keep the shared subset in the committed
  file and apply a documented patch to the baseline checkout.
- **Every fixture is seeded and order-independent.** No fixture, render set or
  query list may depend on `HashMap`/`HashSet` iteration order.
- **Benches are excluded from `cargo test`.** They carry `harness = false` and
  must never gain assertions; a bench that can fail is a test in the wrong place.
- **Generated repos never land in the working tree.** `--out` is mandatory.
- **The frontend bench stays out of the test glob** (`benchmarks/`, not `tests/`)
  and out of `tsconfig.json`'s `include` (which covers `src` only).
- **CI has no timing thresholds.** Adding one requires dedicated hardware first.
