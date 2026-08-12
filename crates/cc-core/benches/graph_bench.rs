//! Criterion benches for the graph model: edge insertion, adjacency rebuild,
//! subgraph extraction, neighborhood BFS and parse-payload serialization.
//!
//! The subgraph/neighborhood benches run on the NESTED fixture from
//! [`common::nested_graph`] with containers collapsed. That matters: on a flat
//! graph the child -> parent map is empty and the ancestor walk that aggregation
//! exists for never runs, so a flat fixture reports "no change" no matter what
//! happens to the parent map. See the doc comment on `common::nested_graph`.

use std::collections::HashSet;
use std::time::Duration;

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};

use cc_core::model::{
    CodeEdge, CodeGraph, EdgeKind, FocusDirection, NodeId, ParseResult, Resolution, SubGraph,
};

mod common;

use common::{all_edge_kinds, flat_graph, nested_graph, NestedGraph, Rng};

/// Seed shared by every fixture in this file, so two runs (or two branches)
/// build byte-identical graphs.
const SEED: u64 = 20_240_611;

/// Build a graph pre-loaded with `n` unique edges so we can benchmark add_edge
/// against a populated graph (the hot path for duplicate checking).
fn make_graph_with_edges(n: usize) -> CodeGraph {
    let mut graph = CodeGraph::new(NodeId("root".into()));
    for i in 0..n {
        graph.add_edge(CodeEdge {
            source: NodeId(format!("src_{i}")),
            target: NodeId(format!("tgt_{i}")),
            kind: EdgeKind::FunctionCall,
            weight: 1,
            resolution: Resolution::GlobalUnique,
        });
    }
    graph
}

/// Benchmark add_edge with all-unique edges (worst case for linear scan).
fn bench_add_edge_unique(c: &mut Criterion) {
    let mut group = c.benchmark_group("add_edge_unique");
    for n in [100, 500, 1000, 5000] {
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, &n| {
            b.iter(|| {
                let mut graph = CodeGraph::new(NodeId("root".into()));
                for i in 0..n {
                    graph.add_edge(CodeEdge {
                        source: NodeId(format!("src_{i}")),
                        target: NodeId(format!("tgt_{i}")),
                        kind: EdgeKind::FunctionCall,
                        weight: 1,
                        resolution: Resolution::GlobalUnique,
                    });
                }
                black_box(&graph);
            });
        });
    }
    group.finish();
}

/// Benchmark add_edge when every insertion is a duplicate (merge path).
fn bench_add_edge_all_duplicates(c: &mut Criterion) {
    let mut group = c.benchmark_group("add_edge_all_duplicates");
    for n in [100, 500, 1000, 5000] {
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, &n| {
            b.iter(|| {
                let mut graph = CodeGraph::new(NodeId("root".into()));
                // All edges share the same (source, target, kind) — every insert after
                // the first hits the duplicate-merge path.
                for _ in 0..n {
                    graph.add_edge(CodeEdge {
                        source: NodeId("a".into()),
                        target: NodeId("b".into()),
                        kind: EdgeKind::FunctionCall,
                        weight: 1,
                        resolution: Resolution::GlobalUnique,
                    });
                }
                black_box(&graph);
            });
        });
    }
    group.finish();
}

/// Benchmark add_edge with a realistic mix: many unique edges plus repeated
/// duplicates scattered throughout.  This simulates a real codebase where
/// the same function is called from multiple sites.
fn bench_add_edge_mixed(c: &mut Criterion) {
    let mut group = c.benchmark_group("add_edge_mixed");
    for n in [500, 1000, 5000] {
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, &n| {
            // Pre-build the edges vec so allocation isn't measured
            let edges: Vec<CodeEdge> = (0..n)
                .map(|i| {
                    // ~20% of edges are duplicates of one of 50 "hot" edges
                    if i % 5 == 0 {
                        let hot = i % 50;
                        CodeEdge {
                            source: NodeId(format!("hot_src_{hot}")),
                            target: NodeId(format!("hot_tgt_{hot}")),
                            kind: EdgeKind::FunctionCall,
                            weight: 1,
                            resolution: Resolution::GlobalUnique,
                        }
                    } else {
                        CodeEdge {
                            source: NodeId(format!("src_{i}")),
                            target: NodeId(format!("tgt_{i}")),
                            kind: EdgeKind::FunctionCall,
                            weight: 1,
                            resolution: Resolution::GlobalUnique,
                        }
                    }
                })
                .collect();

            b.iter(|| {
                let mut graph = CodeGraph::new(NodeId("root".into()));
                for edge in &edges {
                    graph.add_edge(edge.clone());
                }
                black_box(&graph);
            });
        });
    }
    group.finish();
}

/// Benchmark rebuild_adjacency on graphs of increasing size.
fn bench_rebuild_adjacency(c: &mut Criterion) {
    let mut group = c.benchmark_group("rebuild_adjacency");
    for n in [500, 1000, 5000] {
        let graph = make_graph_with_edges(n);
        group.bench_with_input(BenchmarkId::from_parameter(n), &graph, |b, graph| {
            b.iter(|| {
                let mut g = graph.clone();
                g.rebuild_adjacency();
                black_box(&g);
            });
        });
    }
    group.finish();
}

/// `SubGraph::from_graph` on a FLAT graph: no containment hierarchy at all.
///
/// Kept from the original suite, renamed to say what it actually covers. With
/// an empty parent map this measures the direct-edge scan and the render-set
/// membership test ONLY -- no ancestor walking, no aggregation. It is the floor,
/// not the representative case; `subgraph_nested_collapsed` is that.
fn bench_subgraph_flat_no_hierarchy(c: &mut Criterion) {
    let mut group = c.benchmark_group("subgraph_flat_no_hierarchy");
    let kinds = all_edge_kinds();

    for total in [500, 2000] {
        let (graph, visible) = flat_graph(total);
        group.bench_with_input(
            BenchmarkId::new("nodes", total),
            &(&graph, &visible),
            |b, &(graph, visible)| {
                b.iter(|| {
                    black_box(SubGraph::from_graph(graph, visible, &kinds));
                });
            },
        );
    }
    group.finish();
}

/// `SubGraph::from_graph` on the NESTED fixture with containers COLLAPSED --
/// the representative case, and the one that needs the child -> parent map.
///
/// Two render sets per size:
/// - `directories_only`: nothing but the directory tree is on screen, so both
///   endpoints of every edge walk 3-8 links up (block -> class -> file -> dirs).
/// - `dirs_and_files`: files on screen but collapsed, so endpoints walk 1-2
///   links. This is the state a freshly-opened repo is in.
///
/// Sample counts are cut at the larger sizes to keep the suite a few minutes.
fn bench_subgraph_nested_collapsed(c: &mut Criterion) {
    let mut group = c.benchmark_group("subgraph_nested_collapsed");
    group.sample_size(20);
    group.warm_up_time(Duration::from_millis(500));
    group.measurement_time(Duration::from_secs(3));
    let kinds = all_edge_kinds();

    for target in [2_000usize, 10_000, 50_000] {
        let fixture = nested_graph(target, SEED);
        let dirs = fixture.render_dirs();
        let dirs_files = fixture.render_dirs_files();

        group.bench_with_input(
            BenchmarkId::new("directories_only", target),
            &(&fixture.graph, &dirs),
            |b, &(graph, render)| {
                b.iter(|| black_box(SubGraph::from_graph(graph, render, &kinds)));
            },
        );

        group.bench_with_input(
            BenchmarkId::new("dirs_and_files", target),
            &(&fixture.graph, &dirs_files),
            |b, &(graph, render)| {
                b.iter(|| black_box(SubGraph::from_graph(graph, render, &kinds)));
            },
        );
    }
    group.finish();
}

/// `SubGraph::from_graph` with EVERY node rendered.
///
/// No endpoint ever needs lifting, so this isolates the cost of having a parent
/// map available at all from the cost of walking it: any delta here is the map's
/// construction, not its use.
fn bench_subgraph_fully_expanded(c: &mut Criterion) {
    let mut group = c.benchmark_group("subgraph_fully_expanded");
    group.sample_size(20);
    group.warm_up_time(Duration::from_millis(500));
    group.measurement_time(Duration::from_secs(3));
    let kinds = all_edge_kinds();

    for target in [10_000usize, 50_000] {
        let fixture = nested_graph(target, SEED);
        let all = fixture.render_all();
        group.bench_with_input(
            BenchmarkId::from_parameter(target),
            &(&fixture.graph, &all),
            |b, &(graph, render)| {
                b.iter(|| black_box(SubGraph::from_graph(graph, render, &kinds)));
            },
        );
    }
    group.finish();
}

/// Neighborhood BFS (depth 2, both directions) on the nested fixture.
///
/// Each iteration runs a batch of 32 queries against deterministically chosen
/// focus nodes, which is closer to a user's click-through than a single query
/// and keeps per-iteration time above timer noise. The container-chain walk at
/// the end of `neighborhood` also needs the parent map, so this is the second
/// query type the caching change touches.
fn bench_neighborhood(c: &mut Criterion) {
    let mut group = c.benchmark_group("neighborhood_bfs");
    group.sample_size(20);
    group.warm_up_time(Duration::from_millis(500));
    group.measurement_time(Duration::from_secs(3));
    let kinds = all_edge_kinds();

    for target in [10_000usize, 50_000] {
        let fixture = nested_graph(target, SEED);
        let focuses = pick_focus_nodes(&fixture, 32);

        group.bench_with_input(
            BenchmarkId::from_parameter(target),
            &(&fixture.graph, &focuses),
            |b, &(graph, focuses)| {
                b.iter(|| {
                    for focus in focuses {
                        black_box(graph.neighborhood(focus, 2, &kinds, FocusDirection::Both));
                    }
                });
            },
        );
    }
    group.finish();
}

/// Deterministically choose `count` focus nodes from the fixture's edge
/// endpoints (which are sorted, so the choice does not depend on hash order).
fn pick_focus_nodes(fixture: &NestedGraph, count: usize) -> Vec<NodeId> {
    let mut rng = Rng::new(SEED ^ 0x0F0C);
    let mut seen: HashSet<usize> = HashSet::new();
    let mut out = Vec::with_capacity(count);
    while out.len() < count && seen.len() < fixture.edge_endpoints.len() {
        let idx = rng.below(fixture.edge_endpoints.len());
        if seen.insert(idx) {
            out.push(fixture.edge_endpoints[idx].clone());
        }
    }
    out
}

/// Build + serialize the parse payload (`ParseResult` -> JSON).
///
/// This is the IPC cost of opening a repo. The payload SIZE is printed once per
/// fixture to stderr (criterion only reports time), because the shipped win here
/// is as much about bytes crossing the IPC boundary as about the clock.
fn bench_parse_result_serialization(c: &mut Criterion) {
    let mut group = c.benchmark_group("parse_result_serialize");
    group.sample_size(20);
    group.warm_up_time(Duration::from_millis(500));
    group.measurement_time(Duration::from_secs(3));

    for target in [10_000usize, 50_000] {
        let fixture = nested_graph(target, SEED);
        let bytes = serde_json::to_string(&ParseResult::from_graph(&fixture.graph))
            .expect("parse result serializes")
            .len();
        eprintln!(
            "parse_result_serialize/{target}: {} nodes, {} edges, payload {bytes} bytes",
            fixture.graph.node_count(),
            fixture.graph.edge_count()
        );

        group.bench_with_input(
            BenchmarkId::from_parameter(target),
            &fixture.graph,
            |b, graph| {
                b.iter(|| {
                    let result = ParseResult::from_graph(graph);
                    black_box(serde_json::to_string(&result).unwrap());
                });
            },
        );
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_add_edge_unique,
    bench_add_edge_all_duplicates,
    bench_add_edge_mixed,
    bench_rebuild_adjacency,
    bench_subgraph_flat_no_hierarchy,
    bench_subgraph_nested_collapsed,
    bench_subgraph_fully_expanded,
    bench_neighborhood,
    bench_parse_result_serialization,
);
criterion_main!(benches);
