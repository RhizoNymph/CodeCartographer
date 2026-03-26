use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};

use cc_core::model::{CodeEdge, CodeGraph, EdgeKind, NodeId};

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
                        }
                    } else {
                        CodeEdge {
                            source: NodeId(format!("src_{i}")),
                            target: NodeId(format!("tgt_{i}")),
                            kind: EdgeKind::FunctionCall,
                            weight: 1,
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

/// Benchmark SubGraph::from_graph extraction with varying visible-node counts.
fn bench_subgraph_extraction(c: &mut Criterion) {
    use cc_core::model::SubGraph;

    let mut group = c.benchmark_group("subgraph_extraction");
    for total in [500, 2000] {
        // Build a graph with nodes and edges
        let mut graph = CodeGraph::new(NodeId("root".into()));
        for i in 0..total {
            graph.add_node(cc_core::model::CodeNode::File {
                id: NodeId(format!("file_{i}")),
                name: format!("file_{i}.py"),
                path: format!("src/file_{i}.py"),
                language: Some(cc_core::model::Language::Python),
                children: Vec::new(),
            });
        }
        for i in 0..total {
            graph.add_edge(CodeEdge {
                source: NodeId(format!("file_{i}")),
                target: NodeId(format!("file_{}", (i + 1) % total)),
                kind: EdgeKind::Import,
                weight: 1,
            });
        }

        // Visible = half the nodes
        let visible: Vec<NodeId> = (0..total / 2)
            .map(|i| NodeId(format!("file_{i}")))
            .collect();
        let all_kinds: std::collections::HashSet<EdgeKind> = [
            EdgeKind::Import,
            EdgeKind::FunctionCall,
            EdgeKind::MethodCall,
            EdgeKind::TypeReference,
            EdgeKind::Inheritance,
            EdgeKind::TraitImpl,
            EdgeKind::VariableUsage,
        ]
        .into_iter()
        .collect();

        group.bench_with_input(
            BenchmarkId::new("nodes", total),
            &(&graph, &visible, &all_kinds),
            |b, &(graph, visible, kinds)| {
                b.iter(|| {
                    black_box(SubGraph::from_graph(graph, visible, kinds));
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
    bench_subgraph_extraction,
);
criterion_main!(benches);
