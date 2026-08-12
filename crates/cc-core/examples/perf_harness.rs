//! End-to-end performance harness: scan -> parse -> resolve, then the query
//! battery the UI actually issues, printed as one JSON object on stdout.
//!
//! Criterion benches measure single functions on synthetic fixtures. This
//! measures the thing a user waits for: opening a repo, and then interacting
//! with it (expanding/collapsing containers, focusing nodes, drilling into an
//! aggregated edge). It is the most representative number in the suite, and the
//! one to quote when comparing two branches.
//!
//! # Portability across branches
//!
//! This file must compile UNCHANGED on `main` and on the perf branches so the
//! same measurement runs on both. It therefore restricts itself to the cc-core
//! public API that is identical on both sides:
//!
//! - `RepoScanner::scan`, `Extractor::extract_file`
//! - `SymbolTable::build_from_graph`, `SymbolTable::resolve_references`
//! - `ImportResolver::resolve`
//! - `SubGraph::from_graph`, `CodeGraph::neighborhood`, `CodeGraph::edge_detail`
//! - `ParseResult::from_graph` (owned on `main`, borrowing on the perf branch --
//!   the CALL is identical, which is the point: the harness measures the
//!   difference without naming it)
//!
//! It deliberately does NOT touch `build_parent_map` (main-only) or
//! `CodeGraph::parent_map` (perf-branch-only), and never names `ParseResult` as
//! a type.
//!
//! # Determinism
//!
//! Every choice the harness makes -- which nodes go in a render set, which nodes
//! get focused, which aggregated edges get expanded -- is derived from a sorted
//! id list indexed by a seeded SplitMix64 stream. Two runs on the same input
//! therefore do the same work in the same order, so a delta between branches is
//! a delta in cost, not in workload.
//!
//! # Usage
//!
//! ```text
//! cargo run --release --example perf_harness -- --repo /path/to/repo --label main
//! ```
//!
//! Flags: `--repo PATH` (required), `--label NAME`, `--seed N`,
//! `--subgraph-reps N`, `--neighborhood-queries N`, `--edge-detail-queries N`,
//! `--out FILE` (also write the JSON there).

use std::collections::HashSet;
use std::hint::black_box;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use cc_core::model::{
    CodeGraph, CodeNode, EdgeKind, FocusDirection, Language, NodeId, ParseResult, SubGraph,
};
use cc_core::parser::Extractor;
use cc_core::repo::RepoScanner;
use cc_core::resolver::{ImportResolver, SymbolTable};
use rayon::prelude::*;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Deterministic RNG (SplitMix64) -- no rand dependency, identical on both
// branches, and stable across Rust versions.
// ---------------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }
}

/// Pick `count` distinct items from `items` deterministically (sorted input +
/// seeded stream), preserving the sampled order.
fn sample<T: Clone>(rng: &mut Rng, items: &[T], count: usize) -> Vec<T> {
    if items.is_empty() {
        return Vec::new();
    }
    let count = count.min(items.len());
    let mut taken: HashSet<usize> = HashSet::with_capacity(count);
    let mut out = Vec::with_capacity(count);
    // Bounded attempts: with count <= len this terminates quickly, and the
    // fallback sweep guarantees it terminates at all.
    let mut attempts = 0;
    while out.len() < count && attempts < count * 8 {
        attempts += 1;
        let idx = rng.below(items.len());
        if taken.insert(idx) {
            out.push(items[idx].clone());
        }
    }
    for (idx, item) in items.iter().enumerate() {
        if out.len() >= count {
            break;
        }
        if taken.insert(idx) {
            out.push(item.clone());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Summary of a repeated measurement, in milliseconds.
struct Samples {
    values: Vec<f64>,
}

impl Samples {
    fn new() -> Self {
        Samples { values: Vec::new() }
    }

    fn push(&mut self, d: Duration) {
        self.values.push(ms(d));
    }

    fn first(&self) -> f64 {
        self.values.first().copied().unwrap_or(0.0)
    }

    /// Mean of every sample AFTER the first. On a branch that caches derived
    /// state on the graph, the first call pays for the cache and the rest do
    /// not; reporting both separates "cold" from "steady state" instead of
    /// smearing them together.
    fn steady_mean(&self) -> f64 {
        if self.values.len() < 2 {
            return self.first();
        }
        self.values[1..].iter().sum::<f64>() / (self.values.len() - 1) as f64
    }

    fn total(&self) -> f64 {
        self.values.iter().sum()
    }

    fn min(&self) -> f64 {
        self.values.iter().copied().fold(f64::INFINITY, f64::min)
    }

    fn to_json(&self) -> Value {
        json!({
            "samples": self.values.len(),
            "first_ms": self.first(),
            "steady_mean_ms": self.steady_mean(),
            "min_ms": self.min(),
            "total_ms": self.total(),
        })
    }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

struct Args {
    repo: PathBuf,
    label: String,
    seed: u64,
    subgraph_reps: usize,
    neighborhood_queries: usize,
    edge_detail_queries: usize,
    out: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut repo: Option<PathBuf> = None;
    let mut label = "unlabelled".to_string();
    let mut seed = 20_240_611u64;
    let mut subgraph_reps = 6usize;
    let mut neighborhood_queries = 200usize;
    let mut edge_detail_queries = 50usize;
    let mut out: Option<PathBuf> = None;

    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        let mut value = || {
            argv.next()
                .ok_or_else(|| format!("{arg} requires a value"))
        };
        match arg.as_str() {
            "--repo" => repo = Some(PathBuf::from(value()?)),
            "--label" => label = value()?,
            "--seed" => seed = value()?.parse().map_err(|e| format!("--seed: {e}"))?,
            "--subgraph-reps" => {
                subgraph_reps = value()?.parse().map_err(|e| format!("--subgraph-reps: {e}"))?
            }
            "--neighborhood-queries" => {
                neighborhood_queries = value()?
                    .parse()
                    .map_err(|e| format!("--neighborhood-queries: {e}"))?
            }
            "--edge-detail-queries" => {
                edge_detail_queries = value()?
                    .parse()
                    .map_err(|e| format!("--edge-detail-queries: {e}"))?
            }
            "--out" => out = Some(PathBuf::from(value()?)),
            "--help" | "-h" => {
                eprintln!(
                    "perf_harness --repo PATH [--label NAME] [--seed N] \
                     [--subgraph-reps N] [--neighborhood-queries N] \
                     [--edge-detail-queries N] [--out FILE]"
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    Ok(Args {
        repo: repo.ok_or("--repo is required")?,
        label,
        seed,
        subgraph_reps: subgraph_reps.max(2),
        neighborhood_queries,
        edge_detail_queries,
        out,
    })
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/// Every edge kind, i.e. the toolbar's default "show everything" state, which is
/// the most expensive filter and the one the app starts in.
fn all_edge_kinds() -> HashSet<EdgeKind> {
    [
        EdgeKind::Import,
        EdgeKind::FunctionCall,
        EdgeKind::MethodCall,
        EdgeKind::TypeReference,
        EdgeKind::Inheritance,
        EdgeKind::TraitImpl,
        EdgeKind::VariableUsage,
    ]
    .into_iter()
    .collect()
}

struct Pipeline {
    graph: CodeGraph,
    timings: Value,
    stats: Value,
}

/// Scan + parse + resolve, mirroring `cc_tauri::commands::parse_repo` phase for
/// phase (minus the IPC progress events, which are not part of the cost being
/// compared here).
fn run_pipeline(root: &PathBuf) -> anyhow::Result<Pipeline> {
    let t_scan = Instant::now();
    let mut graph = RepoScanner::scan(root)?;
    let scan_ms = ms(t_scan.elapsed());

    let dir_count = graph.nodes.values().filter(|n| n.is_directory()).count();

    // File nodes with a known language, in a deterministic order so the parallel
    // parse is fed identically on every run.
    let mut file_nodes: Vec<(NodeId, String, Language)> = graph
        .nodes
        .iter()
        .filter_map(|(id, node)| match node {
            CodeNode::File {
                path,
                language: Some(lang),
                ..
            } => Some((id.clone(), path.clone(), lang.clone())),
            _ => None,
        })
        .collect();
    file_nodes.sort_by(|a, b| a.1.cmp(&b.1));

    // Phase 1: parse in parallel (I/O + tree-sitter).
    let t_parse = Instant::now();
    let parsed: Vec<(NodeId, Option<(Vec<CodeNode>, Vec<_>)>)> = file_nodes
        .par_iter()
        .map(|(file_id, rel_path, language)| {
            let abs = root.join(rel_path);
            let source = match std::fs::read_to_string(&abs) {
                Ok(s) => s,
                Err(_) => return (file_id.clone(), None),
            };
            match Extractor::extract_file(rel_path, &source, language) {
                Ok(pair) => (file_id.clone(), Some(pair)),
                Err(_) => (file_id.clone(), None),
            }
        })
        .collect();
    let parse_ms = ms(t_parse.elapsed());

    // Phase 2: merge block nodes into the graph and collect raw references.
    let t_merge = Instant::now();
    let mut all_refs = Vec::new();
    let mut total_blocks = 0usize;
    let mut failed_files = 0usize;
    for (file_id, result) in parsed {
        let (nodes, refs) = match result {
            Some(pair) => pair,
            None => {
                failed_files += 1;
                continue;
            }
        };
        total_blocks += nodes.len();
        for node in nodes {
            let is_top_level = matches!(&node, CodeNode::CodeBlock { parent, .. } if *parent == file_id);
            let block_id = node.id().clone();
            graph.add_node(node);
            if is_top_level {
                if let Some(file_node) = graph.nodes.get_mut(&file_id) {
                    file_node.children_mut().push(block_id);
                }
            }
        }
        all_refs.extend(refs);
    }
    let merge_ms = ms(t_merge.elapsed());
    let raw_refs = all_refs.len();

    // Phase 3: resolution.
    let t_symbols = Instant::now();
    let symbol_table = SymbolTable::build_from_graph(&graph);
    let symbol_table_ms = ms(t_symbols.elapsed());
    let symbol_count = symbol_table.symbols.len();

    let t_imports = Instant::now();
    let (import_edges, import_map) = ImportResolver::resolve(&graph, &all_refs);
    let import_resolve_ms = ms(t_imports.elapsed());
    let import_edge_count = import_edges.len();

    let t_import_insert = Instant::now();
    for edge in import_edges {
        graph.add_edge(edge);
    }
    let import_insert_ms = ms(t_import_insert.elapsed());

    let t_resolve = Instant::now();
    let edges = symbol_table.resolve_references(&all_refs, &import_map);
    let symbol_resolve_ms = ms(t_resolve.elapsed());
    let symbol_edge_count = edges.len();

    let t_insert = Instant::now();
    for edge in edges {
        graph.add_edge(edge);
    }
    let symbol_insert_ms = ms(t_insert.elapsed());

    let pipeline_total_ms = scan_ms
        + parse_ms
        + merge_ms
        + symbol_table_ms
        + import_resolve_ms
        + import_insert_ms
        + symbol_resolve_ms
        + symbol_insert_ms;

    let stats = json!({
        "files_parsed": file_nodes.len(),
        "files_failed": failed_files,
        "directories": dir_count,
        "blocks": total_blocks,
        "nodes": graph.node_count(),
        "edges": graph.edge_count(),
        "raw_refs": raw_refs,
        "symbols": symbol_count,
        "import_edges_resolved": import_edge_count,
        "symbol_edges_resolved": symbol_edge_count,
    });

    let timings = json!({
        "scan_ms": scan_ms,
        "parse_files_ms": parse_ms,
        "merge_ms": merge_ms,
        "symbol_table_ms": symbol_table_ms,
        "import_resolve_ms": import_resolve_ms,
        "import_edge_insert_ms": import_insert_ms,
        "symbol_resolve_ms": symbol_resolve_ms,
        "symbol_edge_insert_ms": symbol_insert_ms,
        "pipeline_total_ms": pipeline_total_ms,
    });

    Ok(Pipeline {
        graph,
        timings,
        stats,
    })
}

// ---------------------------------------------------------------------------
// Render sets
// ---------------------------------------------------------------------------

/// One render set plus the label describing what the UI state it stands for.
struct RenderSet {
    name: &'static str,
    ids: Vec<NodeId>,
}

/// Build the render sets the query battery runs against.
///
/// These are the states the canvas is actually in, ordered from "everything
/// collapsed" to "everything expanded". The COLLAPSED ones are the interesting
/// ones: every edge endpoint is a code block that is not in the render set, so
/// aggregation has to walk block -> block -> file -> directory chains for both
/// endpoints of every edge. That walk is what needs a child -> parent map, and
/// it is the work the old flat bench fixture accidentally skipped entirely.
fn build_render_sets(graph: &CodeGraph, rng: &mut Rng) -> Vec<RenderSet> {
    let mut dirs: Vec<NodeId> = Vec::new();
    let mut files: Vec<NodeId> = Vec::new();
    let mut blocks: Vec<NodeId> = Vec::new();

    for (id, node) in graph.nodes.iter() {
        match node {
            CodeNode::Directory { .. } => dirs.push(id.clone()),
            CodeNode::File { .. } => files.push(id.clone()),
            CodeNode::CodeBlock { .. } => blocks.push(id.clone()),
        }
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    files.sort_by(|a, b| a.0.cmp(&b.0));
    blocks.sort_by(|a, b| a.0.cmp(&b.0));

    // Directories + a quarter of the files expanded to their blocks: the state
    // a user lands in after drilling into a couple of packages.
    let expanded_files: HashSet<NodeId> = sample(rng, &files, files.len() / 4)
        .into_iter()
        .collect();
    let mut partial: Vec<NodeId> = dirs.iter().chain(files.iter()).cloned().collect();
    for (id, node) in graph.nodes.iter() {
        if let CodeNode::CodeBlock { parent, .. } = node {
            if expanded_files.contains(parent) {
                partial.push(id.clone());
            }
        }
    }
    partial.sort_by(|a, b| a.0.cmp(&b.0));

    let mut dirs_files: Vec<NodeId> = dirs.iter().chain(files.iter()).cloned().collect();
    dirs_files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut everything: Vec<NodeId> = dirs_files.iter().chain(blocks.iter()).cloned().collect();
    everything.sort_by(|a, b| a.0.cmp(&b.0));

    vec![
        RenderSet {
            name: "directories_only",
            ids: dirs,
        },
        RenderSet {
            name: "directories_and_files",
            ids: dirs_files,
        },
        RenderSet {
            name: "quarter_of_files_expanded",
            ids: partial,
        },
        RenderSet {
            name: "fully_expanded",
            ids: everything,
        },
    ]
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() -> anyhow::Result<()> {
    let args = match parse_args() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("error: {err}");
            std::process::exit(2);
        }
    };

    eprintln!("[perf_harness] label={} repo={}", args.label, args.repo.display());

    let Pipeline {
        graph,
        timings,
        stats,
    } = run_pipeline(&args.repo)?;

    eprintln!(
        "[perf_harness] parsed: {} nodes, {} edges",
        graph.node_count(),
        graph.edge_count()
    );

    let kinds = all_edge_kinds();
    let mut rng = Rng::new(args.seed);

    // --- Payload: build + serialize the parse response -------------------
    //
    // Both branches expose `ParseResult::from_graph`; on `main` it deep-clones
    // the node map, on the perf branch it borrows it and serializes slim nodes.
    // The call site is identical, so the difference lands entirely in these two
    // numbers plus the byte count.
    let mut payload_build = Samples::new();
    let mut payload_serialize = Samples::new();
    let mut payload_bytes = 0usize;
    for _ in 0..3 {
        let t_build = Instant::now();
        let result = ParseResult::from_graph(&graph);
        payload_build.push(t_build.elapsed());

        let t_ser = Instant::now();
        let json = serde_json::to_string(&result)?;
        payload_serialize.push(t_ser.elapsed());
        payload_bytes = json.len();
        black_box(&json);
    }

    // --- Subgraph battery -------------------------------------------------
    let render_sets = build_render_sets(&graph, &mut rng);
    let mut subgraph_report = Vec::new();
    let mut subgraph_total_ms = 0.0f64;

    for set in &render_sets {
        let mut samples = Samples::new();
        let mut direct = 0usize;
        let mut aggregated = 0usize;
        for _ in 0..args.subgraph_reps {
            let t = Instant::now();
            let sub = SubGraph::from_graph(&graph, &set.ids, &kinds);
            samples.push(t.elapsed());
            direct = sub.edges.len();
            aggregated = sub.aggregated_edges.len();
            black_box(&sub);
        }
        subgraph_total_ms += samples.total();
        let mut entry = samples.to_json();
        entry["render_nodes"] = json!(set.ids.len());
        entry["direct_edges"] = json!(direct);
        entry["aggregated_edges"] = json!(aggregated);
        entry["name"] = json!(set.name);
        subgraph_report.push(entry);
        eprintln!(
            "[perf_harness] subgraph {:<26} {:>8} nodes  first {:>8.2}ms  steady {:>8.2}ms",
            set.name,
            set.ids.len(),
            samples.first(),
            samples.steady_mean()
        );
    }

    // --- Neighborhood battery --------------------------------------------
    //
    // Focus nodes are drawn from actual edge endpoints (sorted, then sampled)
    // so every query has something to walk.
    let mut endpoints: Vec<NodeId> = graph
        .edges
        .iter()
        .flat_map(|e| [e.source.clone(), e.target.clone()])
        .collect::<HashSet<NodeId>>()
        .into_iter()
        .collect();
    endpoints.sort_by(|a, b| a.0.cmp(&b.0));
    let focus_nodes = sample(&mut rng, &endpoints, args.neighborhood_queries);

    let mut neighborhood_nodes = 0usize;
    let mut neighborhood_edges = 0usize;
    let t_neighborhood = Instant::now();
    for focus in &focus_nodes {
        if let Some(n) = graph.neighborhood(focus, 2, &kinds, FocusDirection::Both) {
            neighborhood_nodes += n.node_ids.len();
            neighborhood_edges += n.edges.len();
            black_box(&n);
        }
    }
    let neighborhood_ms = ms(t_neighborhood.elapsed());

    // --- Edge-detail battery ----------------------------------------------
    //
    // Drills into the aggregated edges of the most collapsed view -- the exact
    // pairs a user can click on there.
    let collapsed = SubGraph::from_graph(&graph, &render_sets[0].ids, &kinds);
    let pairs: Vec<(NodeId, NodeId)> = collapsed
        .aggregated_edges
        .iter()
        .take(args.edge_detail_queries)
        .map(|e| (e.source.clone(), e.target.clone()))
        .collect();

    let mut edge_detail_edges = 0usize;
    let t_edge_detail = Instant::now();
    for (source, target) in &pairs {
        if let Some(detail) = graph.edge_detail(source, target, &kinds) {
            edge_detail_edges += detail.edges.len();
            black_box(&detail);
        }
    }
    let edge_detail_ms = ms(t_edge_detail.elapsed());

    // --- Report ------------------------------------------------------------
    let report = json!({
        "label": args.label,
        "repo": args.repo.display().to_string(),
        "seed": args.seed,
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "stats": stats,
        "pipeline_ms": timings,
        "payload": {
            "bytes": payload_bytes,
            "build": payload_build.to_json(),
            "serialize": payload_serialize.to_json(),
        },
        "subgraph": {
            "reps_per_render_set": args.subgraph_reps,
            "battery_total_ms": subgraph_total_ms,
            "render_sets": subgraph_report,
        },
        "neighborhood": {
            "queries": focus_nodes.len(),
            "depth": 2,
            "total_ms": neighborhood_ms,
            "mean_ms": if focus_nodes.is_empty() { 0.0 } else { neighborhood_ms / focus_nodes.len() as f64 },
            "nodes_returned": neighborhood_nodes,
            "edges_returned": neighborhood_edges,
        },
        "edge_detail": {
            "queries": pairs.len(),
            "total_ms": edge_detail_ms,
            "mean_ms": if pairs.is_empty() { 0.0 } else { edge_detail_ms / pairs.len() as f64 },
            "edges_returned": edge_detail_edges,
        },
    });

    let rendered = serde_json::to_string_pretty(&report)?;
    if let Some(path) = &args.out {
        std::fs::write(path, format!("{rendered}\n"))?;
    }
    println!("{rendered}");
    Ok(())
}
