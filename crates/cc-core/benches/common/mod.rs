//! Shared fixtures for the cc-core criterion benches.
//!
//! Lives in a SUBDIRECTORY on purpose: cargo auto-discovers `benches/*.rs` as
//! bench targets, so a top-level `benches/common.rs` would be compiled as a
//! bench of its own (and fail, having no `main`). `benches/common/mod.rs` is
//! only ever pulled in by an explicit `mod common;`.
//!
//! The fixtures here exist because the ones they replace measured the wrong
//! thing. See [`nested_graph`] for the specific trap.

#![allow(dead_code)]

use std::collections::HashSet;

use cc_core::model::{
    BlockKind, CodeEdge, CodeGraph, CodeNode, EdgeKind, Language, NodeId, Resolution, Span,
    Visibility,
};

/// Deterministic SplitMix64 stream, so every fixture is byte-identical on every
/// run and on every branch. (Nothing here may depend on `HashMap` iteration
/// order, which is randomized per process.)
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }
}

/// Every edge kind: the toolbar's default state, and the most expensive filter.
pub fn all_edge_kinds() -> HashSet<EdgeKind> {
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

fn span(line: usize) -> Span {
    Span {
        start_line: line,
        start_col: 0,
        end_line: line + 12,
        end_col: 1,
    }
}

/// A nested graph plus the id groups a bench needs to build render sets.
pub struct NestedGraph {
    pub graph: CodeGraph,
    /// Directory ids, sorted.
    pub dirs: Vec<NodeId>,
    /// File ids, sorted.
    pub files: Vec<NodeId>,
    /// Code-block ids (both levels), sorted.
    pub blocks: Vec<NodeId>,
    /// Ids that are an endpoint of at least one edge, sorted.
    pub edge_endpoints: Vec<NodeId>,
}

impl NestedGraph {
    /// Render set: directories only. Every edge endpoint is a code block whose
    /// nearest rendered ancestor is 3-8 links up the chain.
    pub fn render_dirs(&self) -> Vec<NodeId> {
        self.dirs.clone()
    }

    /// Render set: directories + files, i.e. every container expanded down to
    /// file level with the files themselves collapsed. Endpoints lift 1-2 links.
    pub fn render_dirs_files(&self) -> Vec<NodeId> {
        let mut ids = self.dirs.clone();
        ids.extend(self.files.iter().cloned());
        ids
    }

    /// Render set: everything. No lifting happens at all -- the parent map is
    /// built (on `main`, rebuilt per call) and then never walked, which isolates
    /// the map's construction cost from the walk's.
    pub fn render_all(&self) -> Vec<NodeId> {
        let mut ids = self.render_dirs_files();
        ids.extend(self.blocks.iter().cloned());
        ids
    }
}

/// Shape of the directory tree every nested fixture is built on: 3-way fanout,
/// 5 levels, so a leaf directory sits 5 links below the root and a nested code
/// block sits 8 links below it.
const TREE_DEPTH: usize = 5;
const TREE_FANOUT: usize = 3;
/// Top-level blocks per file, each carrying `NESTED_BLOCKS` children (a class
/// with methods, a module with functions).
const BLOCKS_PER_FILE: usize = 5;
const NESTED_BLOCKS: usize = 2;
/// Nodes contributed by one file: itself plus its block subtree.
const NODES_PER_FILE: usize = 1 + BLOCKS_PER_FILE * (1 + NESTED_BLOCKS);

/// Build a nested `Directory > File > CodeBlock > CodeBlock` graph of roughly
/// `target_nodes` nodes, with cross-file edges between the DEEPEST blocks.
///
/// # Why this shape
///
/// The fixture this replaces built `target_nodes` flat `File` nodes with empty
/// `children` arrays and put every edge between two of them. That graph has an
/// EMPTY parent map, so `find_render_ancestor` returned on its first probe and
/// the aggregation path -- the entire reason `SubGraph::from_graph` needs a
/// parent map -- never ran. It benchmarked the one input for which the parent
/// map does not matter, and would report "no change" for any amount of work
/// saved building or reusing it.
///
/// Here every edge endpoint is a leaf code block, and the render sets used by
/// the benches keep the containers COLLAPSED, so both endpoints of every edge
/// have to be walked up a real ancestor chain before the edge can be
/// aggregated. That is the shape the app is in whenever a repo is first opened.
pub fn nested_graph(target_nodes: usize, seed: u64) -> NestedGraph {
    let mut rng = Rng::new(seed);
    let mut graph = CodeGraph::new(NodeId("root".into()));

    // --- directory tree ---------------------------------------------------
    // Breadth-first so the ids are assigned level by level; `children` is filled
    // in as each level is created.
    let mut dir_paths: Vec<String> = vec!["root".to_string()];
    let mut dir_children: Vec<Vec<NodeId>> = vec![Vec::new()];
    let mut dir_of_depth: Vec<usize> = vec![0];
    let mut level: Vec<usize> = vec![0];

    for _ in 0..TREE_DEPTH {
        let mut next = Vec::new();
        for parent_idx in level {
            for k in 0..TREE_FANOUT {
                let path = format!("{}/dir_{}", dir_paths[parent_idx], k);
                let idx = dir_paths.len();
                dir_paths.push(path);
                dir_children.push(Vec::new());
                dir_of_depth.push(dir_of_depth[parent_idx] + 1);
                dir_children[parent_idx].push(NodeId(dir_paths[idx].clone()));
                next.push(idx);
            }
        }
        level = next;
    }

    // --- files, distributed round-robin over every non-root directory ------
    let placeable: Vec<usize> = (1..dir_paths.len()).collect();
    let file_count = target_nodes
        .saturating_sub(dir_paths.len())
        .div_ceil(NODES_PER_FILE)
        .max(1);

    let mut files: Vec<NodeId> = Vec::with_capacity(file_count);
    let mut blocks: Vec<NodeId> = Vec::new();
    // Deepest blocks only: these are the edge endpoints, so every edge has the
    // full ancestor chain above it.
    let mut leaf_blocks: Vec<NodeId> = Vec::new();

    for f in 0..file_count {
        let dir_idx = placeable[f % placeable.len()];
        let file_path = format!("{}/file_{f}.py", dir_paths[dir_idx]);
        let file_id = NodeId::file(&file_path);
        dir_children[dir_idx].push(file_id.clone());

        let mut file_children = Vec::with_capacity(BLOCKS_PER_FILE);
        for b in 0..BLOCKS_PER_FILE {
            let block_id = NodeId::code_block(&file_path, &format!("Class_{f}_{b}"), b * 40);
            let mut nested = Vec::with_capacity(NESTED_BLOCKS);
            for m in 0..NESTED_BLOCKS {
                let method_id =
                    NodeId::code_block(&file_path, &format!("method_{f}_{b}_{m}"), b * 40 + m * 10);
                graph.add_node(CodeNode::CodeBlock {
                    id: method_id.clone(),
                    name: format!("method_{f}_{b}_{m}"),
                    kind: BlockKind::Function,
                    span: span(b * 40 + m * 10),
                    signature: Some(format!("def method_{f}_{b}_{m}(self, value=None):")),
                    visibility: Some(Visibility::Public),
                    parent: block_id.clone(),
                    children: Vec::new(),
                });
                nested.push(method_id.clone());
                blocks.push(method_id.clone());
                leaf_blocks.push(method_id);
            }
            graph.add_node(CodeNode::CodeBlock {
                id: block_id.clone(),
                name: format!("Class_{f}_{b}"),
                kind: BlockKind::Class,
                span: span(b * 40),
                signature: Some(format!("class Class_{f}_{b}:")),
                visibility: Some(Visibility::Public),
                parent: file_id.clone(),
                children: nested,
            });
            file_children.push(block_id.clone());
            blocks.push(block_id);
        }

        graph.add_node(CodeNode::File {
            id: file_id.clone(),
            name: format!("file_{f}.py"),
            path: file_path,
            language: Some(Language::Python),
            children: file_children,
        });
        files.push(file_id);
    }

    for (idx, path) in dir_paths.iter().enumerate() {
        graph.add_node(CodeNode::Directory {
            id: NodeId::directory(path),
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            path: path.clone(),
            children: std::mem::take(&mut dir_children[idx]),
        });
    }

    // --- edges between leaf blocks in DIFFERENT files ----------------------
    // ~4 per file, mixed kinds, so aggregation has several kinds to key on.
    let kinds = [
        EdgeKind::FunctionCall,
        EdgeKind::MethodCall,
        EdgeKind::Import,
        EdgeKind::TypeReference,
    ];
    let edge_count = file_count * 4;
    for e in 0..edge_count {
        let source = leaf_blocks[rng.below(leaf_blocks.len())].clone();
        let target = leaf_blocks[rng.below(leaf_blocks.len())].clone();
        if source == target {
            continue;
        }
        graph.add_edge(CodeEdge {
            source,
            target,
            kind: kinds[e % kinds.len()].clone(),
            weight: 1,
            resolution: Resolution::GlobalUnique,
        });
    }

    let mut dirs: Vec<NodeId> = dir_paths.iter().map(|p| NodeId::directory(p)).collect();
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    files.sort_by(|a, b| a.0.cmp(&b.0));
    blocks.sort_by(|a, b| a.0.cmp(&b.0));

    let mut edge_endpoints: Vec<NodeId> = graph
        .edges
        .iter()
        .flat_map(|e| [e.source.clone(), e.target.clone()])
        .collect::<HashSet<NodeId>>()
        .into_iter()
        .collect();
    edge_endpoints.sort_by(|a, b| a.0.cmp(&b.0));

    NestedGraph {
        graph,
        dirs,
        files,
        blocks,
        edge_endpoints,
    }
}

/// Build a flat graph of `n` `File` nodes with empty `children` and one edge per
/// node -- the OLD subgraph fixture, kept for what it genuinely measures.
///
/// With no containment hierarchy the parent map is empty, so this isolates the
/// direct-edge scan and render-set membership test with zero ancestor walking.
pub fn flat_graph(n: usize) -> (CodeGraph, Vec<NodeId>) {
    let mut graph = CodeGraph::new(NodeId("root".into()));
    for i in 0..n {
        graph.add_node(CodeNode::File {
            id: NodeId(format!("file_{i}")),
            name: format!("file_{i}.py"),
            path: format!("src/file_{i}.py"),
            language: Some(Language::Python),
            children: Vec::new(),
        });
    }
    for i in 0..n {
        graph.add_edge(CodeEdge {
            source: NodeId(format!("file_{i}")),
            target: NodeId(format!("file_{}", (i + 1) % n)),
            kind: EdgeKind::Import,
            weight: 1,
            resolution: Resolution::GlobalUnique,
        });
    }
    let visible: Vec<NodeId> = (0..n / 2).map(|i| NodeId(format!("file_{i}"))).collect();
    (graph, visible)
}
