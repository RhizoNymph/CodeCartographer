# `main` vs `feat/perf-integration` -- measured

One machine, sequential runs, same inputs. Method and caveats are stated before
the numbers because several of them change what the numbers mean.

- **Baseline**: `origin/main` @ `30ab9b5` (2026-08-02)
- **Branch**: `origin/feat/perf-integration` @ `1e8903e` (2026-08-11), PR #51
- **Measured from**: `test/perf-benchmarks` @ `ab94907`, whose benchmark files
  were copied UNCOMMITTED into a detached `main` worktree so both sides run
  byte-identical measurement code. No source patch was needed: the harness and
  both bench files compile unchanged on `main`. The only extra file copied in was
  `crates/cc-core/Cargo.toml`, for its `[lib] bench = false` line (without it
  `cargo bench -p cc-core -- <criterion flags>` fails before running anything).

## Environment

| | |
| --- | --- |
| CPU | AMD Ryzen 7 7840U (8 cores / 16 threads, 3.30 GHz max) |
| Memory | 60 GiB |
| OS | Ubuntu 26.04 LTS, Linux 7.0.0-29-generic x86_64 |
| Rust | rustc 1.99.0-nightly (8ab9fdff5 2026-07-30) |
| Node | v24.10.0 |
| Python | 3.14.4 |

Laptop CPU with boost and thermal headroom in play: treat sub-5% differences as
noise. The frontend control scenario below shows the actual run-to-run agreement
achieved (under 1%).

## Build profiles -- read this before the criterion table

`cargo bench` inherits from `[profile.release]`, and the branch changes it:

| | `main` | `feat/perf-integration` |
| --- | --- | --- |
| `[profile.release]` | cargo defaults (`lto = false`, `codegen-units = 16`) | `lto = "thin"`, `codegen-units = 1` |

That asymmetry is real shipping behaviour, so the primary comparison keeps it.
But it inflates every number, including ones the branch did not touch, so there
is also a **profile-matched** column: the branch re-benched with
`CARGO_PROFILE_BENCH_LTO=false CARGO_PROFILE_BENCH_CODEGEN_UNITS=16`. The gap
between the two columns is the build flags; what survives in the matched column
is the algorithm.

The matched column reads as a control: every benchmark the branch did not touch
lands within ±2% (`add_edge_unique`, `add_edge_mixed`, `rebuild_adjacency`,
`extract_many_files`, `full_pipeline`), while the targeted ones keep their full
win. The 5-8% that those untouched benchmarks show in the shipping column is
thin LTO, not a change in the code.

## Exact commands

```bash
# Inputs, generated once, outside both checkouts
for p in small medium large; do
  python3 benchmarks/gen_repo.py --preset $p --out "$BENCH/cc-$p" --force
done

# Baseline
git worktree add --detach "$BENCH/main-baseline" origin/main
#   ... copy benchmarks/, crates/cc-core/examples/, crates/cc-core/benches/,
#       packages/app/benchmarks/ and crates/cc-core/Cargo.toml in, uncommitted
cd "$BENCH/main-baseline" && pnpm install --dir packages/app
bash benchmarks/run_all.sh main "$BENCH/results/main" "$BENCH" "$BENCH/main-baseline"

# Branch
bash benchmarks/run_all.sh perf-integration "$BENCH/results/integration" \
  "$BENCH" "$BENCH/main-baseline"

# Profile-matched criterion re-run on the branch
CARGO_PROFILE_BENCH_LTO=false CARGO_PROFILE_BENCH_CODEGEN_UNITS=16 \
  cargo bench -p cc-core -- --warm-up-time 1 --measurement-time 3 --sample-size 20
```

Both harness runs point at the SAME real-repo path (`$BENCH/main-baseline`), so
the "real repo" case reads an identical source tree on both sides. Synthetic
repos come from the same seed (`20240611`) and are byte-identical.

Criterion: `--warm-up-time 1 --measurement-time 3 --sample-size 20`; groups that
set their own sampling (the newer, heavier ones) keep it at 20 samples / 3 s.

---

# Headline

| Metric | `main` | `feat/perf-integration` | Delta |
| --- | --- | --- | --- |
| Open a 10k-file repo, full pipeline | 10 750 ms | 3 068 ms | **-71.5%** |
| ...of which symbol resolution | 8 435 ms | 789 ms | **-90.6%** |
| 200 neighborhood queries (10k-file repo) | 24 147 ms | 6 170 ms | **-74.4%** |
| Subgraph battery, 24 extractions (10k-file repo) | 14 021 ms | 11 331 ms | -19.2% |
| 50 edge-detail drill-ins (10k-file repo) | 12 686 ms | 7 185 ms | -43.4% |
| Parse payload, 10k-file repo | 69.61 MB | 64.21 MB | -7.8% |
| Canvas redraw, 1500 nodes / 1200 edges | 3 643 ms | ~0 ms (routing skipped) | **-100%** |
| Canvas redraw, 800 nodes / 500 edges | 789 ms | 136 ms | **-82.7%** |

---

## 1. End-to-end harness

`crates/cc-core/examples/perf_harness.rs`, release build, seed 20240611.
Subgraph render sets are measured 6x each; `steady` is the mean of samples 2-6.

### 1a. Synthetic `large` -- 11 365 files, 142 730 nodes, 374 703 edges, 950 000 raw refs

| Metric | `main` | branch | Delta |
| --- | --- | --- | --- |
| scan | 131.5 ms | 128.8 ms | -2.1% |
| parse files (rayon) | 741.9 ms | 676.4 ms | -8.8% |
| merge blocks | 238.9 ms | 228.3 ms | -4.5% |
| build symbol table | 533.9 ms | 567.4 ms | +6.3% |
| resolve imports | 104.4 ms | 118.0 ms | +12.9% |
| insert import edges | 46.3 ms | 49.9 ms | +7.8% |
| **resolve symbols** | **8 434.7 ms** | **789.2 ms** | **-90.6%** |
| insert symbol edges | 518.4 ms | 509.8 ms | -1.7% |
| **pipeline total** | **10 750.1 ms** | **3 067.8 ms** | **-71.5%** |
| payload bytes | 69.61 MB | 64.21 MB | -7.8% |
| payload build | 285.7 ms | 174.4 ms | -39.0% |
| payload serialize | 144.0 ms | 217.4 ms | **+51.0%** |
| payload build + serialize | 429.7 ms | 391.8 ms | -8.8% |
| subgraph battery (4 render sets x 6) | 14 021.2 ms | 11 330.7 ms | -19.2% |
| &nbsp;&nbsp;directories_only (1 365 render nodes), steady | 591.7 ms | 481.9 ms | -18.6% |
| &nbsp;&nbsp;directories_and_files (12 730), steady | 558.4 ms | 446.0 ms | -20.1% |
| &nbsp;&nbsp;quarter_of_files_expanded (32 770), steady | 651.4 ms | 512.2 ms | -21.4% |
| &nbsp;&nbsp;fully_expanded (142 730), steady | 538.6 ms | 436.0 ms | -19.1% |
| neighborhood x200, depth 2 | 24 146.5 ms | 6 169.9 ms | **-74.4%** |
| edge_detail x50 | 12 685.8 ms | 7 184.5 ms | -43.4% |

### 1b. Synthetic `medium` -- 2 333 files, 28 666 nodes, 75 451 edges

| Metric | `main` | branch | Delta |
| --- | --- | --- | --- |
| resolve symbols | 331.4 ms | 143.0 ms | -56.8% |
| pipeline total | 744.4 ms | 542.2 ms | -27.2% |
| payload bytes | 12.73 MB | 11.66 MB | -8.4% |
| payload build + serialize | 52.2 ms | 51.9 ms | -0.6% |
| subgraph battery | 2 061.7 ms | 1 620.4 ms | -21.4% |
| neighborhood x200 | 3 151.4 ms | 1 080.7 ms | -65.7% |
| edge_detail x50 | 1 656.0 ms | 1 095.3 ms | -33.9% |

### 1c. Synthetic `small` -- 233 files, 2 666 nodes, 3 880 edges

| Metric | `main` | branch | Delta |
| --- | --- | --- | --- |
| pipeline total | 33.1 ms | 27.2 ms | -17.9% |
| payload bytes | 0.99 MB | 0.89 MB | -9.8% |
| subgraph battery | 61.7 ms | 47.1 ms | -23.5% |
| neighborhood x200 | 142.3 ms | 37.0 ms | -74.0% |
| edge_detail x50 | 56.2 ms | 29.6 ms | -47.4% |

### 1d. The CodeCartographer repo itself -- 120 files, 1 317 nodes, 4 147 edges

The realistic small-repo case: mixed Rust/TypeScript, real symbol distribution.

| Metric | `main` | branch | Delta |
| --- | --- | --- | --- |
| pipeline total | 48.2 ms | 41.7 ms | -13.4% |
| payload bytes | 0.70 MB | 0.64 MB | -9.1% |
| payload build + serialize | 2.0 ms | 1.7 ms | -15.4% |
| subgraph battery | 81.9 ms | 66.5 ms | -18.8% |
| neighborhood x200 | 142.3 ms | 76.8 ms | -46.0% |
| edge_detail x50 | 60.0 ms | 43.7 ms | -27.2% |

Note how flat the branch's subgraph times are across render-set sizes in every
table: on `main` the cost is dominated by rebuilding the parent map, which
depends on the GRAPH size, not the render set, so all four render sets cost about
the same. Removing that rebuild is what makes the numbers start tracking the work
the query actually does.

## 2. Criterion microbenchmarks

Median of 20 samples. "shipping" is each branch's own release profile; "matched"
is the branch rebuilt with `main`'s LTO/codegen-units.

### Targeted by the perf work

| Benchmark | `main` | branch (shipping) | branch (matched) | Delta (matched) |
| --- | --- | --- | --- | --- |
| `resolve_hub_ambiguity/ambiguous_resolve/1000` | 1.222 s | 3.77 ms | 4.53 ms | **-99.6%** |
| `resolve_hub_ambiguity/ambiguous_resolve/500` | 282.7 ms | 1.94 ms | 2.23 ms | **-99.2%** |
| `neighborhood_bfs/50000` | 1.021 s | 26.08 ms | 24.67 ms | **-97.6%** |
| `neighborhood_bfs/10000` | 101.1 ms | 3.90 ms | 3.77 ms | **-96.3%** |
| `subgraph_fully_expanded/50000` | 46.26 ms | 17.07 ms | 16.92 ms | -63.4% |
| `subgraph_fully_expanded/10000` | 5.49 ms | 1.88 ms | 2.00 ms | -63.6% |
| `subgraph_nested_collapsed/directories_only/10000` | 9.43 ms | 4.46 ms | 4.25 ms | -55.0% |
| `subgraph_nested_collapsed/directories_only/2000` | 1.066 ms | 532.6 us | 545.4 us | -48.8% |
| `subgraph_nested_collapsed/dirs_and_files/2000` | 1.037 ms | 524.0 us | 535.3 us | -48.4% |
| `subgraph_nested_collapsed/dirs_and_files/10000` | 7.98 ms | 4.17 ms | 4.18 ms | -47.6% |
| `subgraph_nested_collapsed/dirs_and_files/50000` | 71.05 ms | 39.06 ms | 40.02 ms | -43.7% |
| `subgraph_nested_collapsed/directories_only/50000` | 66.36 ms | 38.59 ms | 39.35 ms | -40.7% |
| `add_edge_all_duplicates/1000` | 112.3 us | 65.8 us | 72.6 us | -35.4% |
| `parse_result_serialize/10000` | 14.17 ms | 9.94 ms | 9.79 ms | -30.9% |
| `parse_result_serialize/50000` | 92.63 ms | 81.00 ms | 79.10 ms | -14.6% |

### Not targeted -- the control

| Benchmark | `main` | branch (shipping) | branch (matched) | Delta (matched) |
| --- | --- | --- | --- | --- |
| `add_edge_unique/5000` | 4.101 ms | 3.773 ms | 4.069 ms | -0.8% |
| `add_edge_mixed/5000` | 3.397 ms | 3.116 ms | 3.371 ms | -0.7% |
| `rebuild_adjacency/5000` | 4.223 ms | 4.177 ms | 4.156 ms | -1.6% |
| `subgraph_flat_no_hierarchy/nodes/2000` | 426.3 us | 401.2 us | 410.1 us | -3.8% |
| `extract_many_files/100` | 47.17 ms | 46.48 ms | 47.42 ms | +0.5% |
| `full_pipeline/50` | 26.45 ms | 25.76 ms | 26.34 ms | -0.4% |
| `resolve_hub_ambiguity/unique_control_resolve/1000` | 2.662 ms | 2.405 ms | 2.639 ms | -0.9% |
| `resolve_hub_ambiguity/ambiguous_build_table/1000` | 5.518 ms | 5.451 ms | 5.737 ms | +4.0% |

`subgraph_flat_no_hierarchy` is the OLD subgraph fixture. It moves -3.8%, and
that is the entire point: on a flat graph the parent map is empty, the ancestor
walk never runs, and the change under test is invisible. The same code path on
the nested fixture moves -40% to -55%. A fixture that skips the hot path reports
a confident zero.

## 3. Frontend edge routing

`packages/app/benchmarks/edgeRouting.bench.ts`, mean of 5 reps, Node v24.10.0.

| Layout | Scenario | `main` | branch | Delta |
| --- | --- | --- | --- | --- |
| 300n / 200e | `full_scan_routing` (control) | 134.5 ms | 133.2 ms | -1.0% |
| | `indexed_routing` | n/a (no `obstacleIndex.ts`) | 47.6 ms | |
| | **`shipped_redraw`** | **127.8 ms** | **45.4 ms** (mode `full`) | **-64.5%** |
| 800n / 500e | `full_scan_routing` (control) | 794.1 ms | 785.3 ms | -1.1% |
| | `indexed_routing` | n/a | 252.1 ms | |
| | **`shipped_redraw`** | **789.4 ms** | **136.3 ms** (mode `obstacles`) | **-82.7%** |
| 1500n / 1200e | `full_scan_routing` (control) | 3 721.6 ms | 3 718.9 ms | -0.1% |
| | `indexed_routing` | n/a | 1 223.8 ms | |
| | **`shipped_redraw`** | **3 643.1 ms** | **~0 ms** (mode `none`) | **-100%** |

The control scenario -- obstacle collection by full scan, reimplemented inside
the bench so it is identical on both branches -- agrees to within 1.1% at every
size. That is the evidence that the two runs are comparable and that the other
rows are the code, not the machine.

Reading the branch's own two rows against each other separates the two
mechanisms: the R-tree obstacle index alone is a 2.8x-3.0x win
(`full_scan_routing` -> `indexed_routing`), and the budget gate contributes the
rest by dropping crossing-aware scoring above 250 edges and skipping routing
entirely above 500 edges or 2000 nodes.

`main` never took 3.6 s of main-thread time in one go for a 1200-edge view in
practice, because it hit ELK's own node-count guard first -- but nothing bounded
the redraw pass itself, which is what these numbers measure.

---

# Claims: confirmed and contradicted

## Confirmed

1. **Cached parent map (`get_subgraph` / `neighborhood` / `edge_detail`).**
   Strongly confirmed, and larger than advertised for BFS. `neighborhood_bfs` at
   50k nodes drops 97.6%, because `main` rebuilt a 50k-entry `HashMap<NodeId,
   NodeId>` -- two `String` clones per child link -- on every single query. In the
   harness, 200 neighborhood queries on the 10k-file repo go from 24.1 s to 6.2 s
   (-74.4%), and 50 edge-detail drill-ins from 12.7 s to 7.2 s (-43.4%).
   Subgraph extraction is -19% to -21% end to end and -41% to -55% in the
   microbenchmark.

2. **Ambiguity early-bail in symbol resolution.** Strongly confirmed, and the
   single biggest win in the suite. On the synthetic 10k-file repo (half the
   modules defining the same hub names), symbol resolution drops from 8.43 s to
   0.79 s (-90.6%), taking the whole pipeline from 10.75 s to 3.07 s (-71.5%).
   The microbenchmark isolates it: with 1000 files defining `__init__`/`new`/
   `get`/`run`/`handle`, resolving 10 000 references goes from 1.22 s to 3.8 ms.
   `main` was cloning hundreds of `NodeId`s per reference and then discarding all
   of them at the 5-candidate cap. The matching `unique_control` benchmark, same
   volume with unique names, is unchanged (-0.9%) -- so nothing was traded away
   for it.

3. **Obstacle-indexed edge routing plus budget gates.** Confirmed. The index
   alone is 2.8x-3.0x; the shipped redraw is -64.5% at 300n/200e, -82.7% at
   800n/500e and -100% at 1500n/1200e where the budget skips routing outright.
   The 250/500-edge gates behave exactly as documented.

4. **`into_iter` edge insertion.** Real but small: `add_edge_all_duplicates/1000`
   is -35% and edge insertion in the harness is within noise (-1.7% at the large
   size). It removes a clone per edge; edge insertion was never the bottleneck.

## Contradicted or overstated

5. **"~-22% payload" for the slim `ParseResult`. Not reproduced.** Measured
   payload reduction is **-7.8%** (synthetic large), **-8.4%** (medium), **-9.8%**
   (small) and **-9.1%** (the CodeCartographer repo itself). Dumping the `main`
   payload for this repo and measuring per field explains why:

   | field | bytes | share of payload |
   | --- | --- | --- |
   | `children` | 103 362 | 14.7% |
   | `id` | 90 610 | 12.9% |
   | node-map keys | 84 025 | 11.9% |
   | `span` | 81 003 | 11.5% |
   | **`signature`** | **64 206** | **9.1%** |
   | `parent` | 63 917 | 9.1% |
   | `name` | 38 025 | 5.4% |
   | everything else | ~79 000 | ~11% |

   So the docstring in `graph.rs` (and `docs/features/server_side_graph_state.md`)
   calling `signature` "the single largest contributor to the payload" is wrong
   for this repo: it is the fifth largest, behind `children`, `id`, the node-map
   keys and `span`. The node id is in fact paid for **three times** -- as the map
   key, as the `id` field, and again as each child's entry in its parent's
   `children` array -- which together are 39.5% of the payload. That is where the
   next payload win is, not in dropping more per-node fields.

6. **"Serialization without the node-map deep clone" is a clear time win.**
   Half right, and worth knowing. Building the `ParseResult` IS much cheaper
   (-39.0% at the large size, -35.9% at small: no deep clone). But SERIALIZING
   the slim borrowed form is **slower** -- +51.0% at the large size, +71.2% at
   medium -- despite emitting fewer bytes. Net build+serialize is -8.8% (large),
   -0.6% (medium), -15.4% (this repo): somewhere between neutral and modest, not
   the step change the build-side number alone suggests. The plausible mechanism
   is locality: `main` serializes a freshly written contiguous clone, the branch
   walks the live node map and constructs a `SlimNode` per entry. Worth a look if
   payload time ever matters; the memory saving (no second copy of the node map)
   stands regardless.

7. **Import resolution and symbol-table construction got slightly slower** on
   the largest input (+12.9% and +6.3% respectively at the 10k-file size, though
   -16% to -33% at the small size). This is a few hundred milliseconds against a
   7.7-second win elsewhere, and the direction flips with size, so it is most
   likely allocator/cache behaviour at the new working-set size rather than a
   real regression. Flagged rather than explained.

## Where the numbers came from

Raw output (harness JSON per size, criterion text for all three profiles,
frontend JSON) is not committed -- rerun `benchmarks/run_all.sh` to regenerate
it. The procedure is documented in `docs/features/benchmarking.md`.
