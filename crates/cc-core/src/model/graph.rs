use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::edge_index::EdgeIndex;
use super::{AggregatedEdge, CodeEdge, CodeNode, EdgeKind, NodeId};

/// The full code graph for a repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeGraph {
    pub nodes: HashMap<NodeId, CodeNode>,
    pub edges: Vec<CodeEdge>,
    pub root: NodeId,
    /// Forward adjacency: source -> [(target, edge_index)]
    #[serde(skip)]
    pub forward_adj: HashMap<NodeId, Vec<(NodeId, usize)>>,
    /// Reverse adjacency: target -> [(source, edge_index)]
    #[serde(skip)]
    pub reverse_adj: HashMap<NodeId, Vec<(NodeId, usize)>>,
    /// Dedup index: (source, target, kind) -> edge index
    #[serde(skip)]
    pub edge_index: EdgeIndex,
}

impl CodeGraph {
    pub fn new(root_id: NodeId) -> Self {
        Self {
            nodes: HashMap::new(),
            edges: Vec::new(),
            root: root_id,
            forward_adj: HashMap::new(),
            reverse_adj: HashMap::new(),
            edge_index: EdgeIndex::new(),
        }
    }

    pub fn add_node(&mut self, node: CodeNode) {
        self.nodes.insert(node.id().clone(), node);
    }

    pub fn add_edge(&mut self, edge: CodeEdge) {
        if let Some(idx) = self.edge_index.get(&edge.source, &edge.target, &edge.kind) {
            self.edges[idx].weight = self.edges[idx].weight.saturating_add(edge.weight);
            return;
        }
        let idx = self.edges.len();
        self.edge_index.insert(
            edge.source.clone(),
            edge.target.clone(),
            edge.kind.clone(),
            idx,
        );
        self.forward_adj
            .entry(edge.source.clone())
            .or_default()
            .push((edge.target.clone(), idx));
        self.reverse_adj
            .entry(edge.target.clone())
            .or_default()
            .push((edge.source.clone(), idx));
        self.edges.push(edge);
    }

    pub fn node(&self, id: &NodeId) -> Option<&CodeNode> {
        self.nodes.get(id)
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// Rebuild adjacency indexes from the edges vec.
    pub fn rebuild_adjacency(&mut self) {
        self.forward_adj.clear();
        self.reverse_adj.clear();
        for (idx, edge) in self.edges.iter().enumerate() {
            self.forward_adj
                .entry(edge.source.clone())
                .or_default()
                .push((edge.target.clone(), idx));
            self.reverse_adj
                .entry(edge.target.clone())
                .or_default()
                .push((edge.source.clone(), idx));
        }
        self.edge_index.rebuild(&self.edges);
    }
}

/// Build a child -> parent map from every node's `children` array.
///
/// After the parsing phase populates the `children` hierarchy, this yields the
/// authoritative parent map used for lifting edge endpoints to ancestors.
pub fn build_parent_map(graph: &CodeGraph) -> HashMap<NodeId, NodeId> {
    let mut parent_map = HashMap::new();
    for (node_id, node) in graph.nodes.iter() {
        for child_id in node.children() {
            parent_map.insert(child_id.clone(), node_id.clone());
        }
    }
    parent_map
}

/// Walk up the parent chain from `node_id` until a node in `render_set` is
/// found. Returns the node itself if it is already in the set, or `None` if no
/// ancestor is in the set.
fn find_render_ancestor<'a>(
    node_id: &'a NodeId,
    render_set: &'a HashSet<&NodeId>,
    parent_map: &'a HashMap<NodeId, NodeId>,
) -> Option<&'a NodeId> {
    let mut current = node_id;
    loop {
        if let Some(found) = render_set.get(current) {
            return Some(*found);
        }
        match parent_map.get(current) {
            Some(parent) => current = parent,
            None => return None,
        }
    }
}

/// Return true if `maybe_ancestor` is a (strict) ancestor of `node_id` in the
/// parent map.
fn is_ancestor_of(
    maybe_ancestor: &NodeId,
    node_id: &NodeId,
    parent_map: &HashMap<NodeId, NodeId>,
) -> bool {
    let mut current = parent_map.get(node_id);
    while let Some(c) = current {
        if c == maybe_ancestor {
            return true;
        }
        current = parent_map.get(c);
    }
    false
}

/// A filtered subgraph for frontend rendering.
///
/// The frontend already holds the node tree, so a `SubGraph` only carries the
/// per-view edges computed server-side: `edges` (both endpoints present in the
/// render set) and `aggregated_edges` (edges lifted to their nearest rendered
/// ancestor for collapsed containers).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubGraph {
    pub edges: Vec<CodeEdge>,
    pub aggregated_edges: Vec<AggregatedEdge>,
}

impl SubGraph {
    /// Compute the direct + aggregated edges for a given render view.
    ///
    /// `render_ids` are the node ids actually present in the layout tree (nodes
    /// that are visible AND whose ancestors are all expanded -- the frontend's
    /// `elkNodeIds`). `enabled_edge_kinds` filters by edge kind.
    ///
    /// - Direct edges: both endpoints in `render_ids`, kind enabled.
    /// - Aggregated edges: for edges with at least one endpoint NOT in
    ///   `render_ids`, lift each endpoint to its nearest ancestor in the set;
    ///   skip when unresolvable, when both lift to the same node (self-loop), or
    ///   when one lifted endpoint is an ancestor of the other. Deduped by
    ///   (source, target) keeping the first kind seen; `count` accumulates the
    ///   number of underlying edges collapsed into each aggregated edge.
    pub fn from_graph(
        graph: &CodeGraph,
        render_ids: &[NodeId],
        enabled_edge_kinds: &HashSet<EdgeKind>,
    ) -> Self {
        let render_set: HashSet<&NodeId> = render_ids.iter().collect();
        let parent_map = build_parent_map(graph);

        let mut edges: Vec<CodeEdge> = Vec::new();
        // Preserve insertion order of aggregated edges for stable output.
        let mut agg_order: Vec<(NodeId, NodeId)> = Vec::new();
        let mut agg_map: HashMap<(NodeId, NodeId), AggregatedEdge> = HashMap::new();

        for edge in graph.edges.iter() {
            if !enabled_edge_kinds.contains(&edge.kind) {
                continue;
            }

            let source_in = render_set.contains(&edge.source);
            let target_in = render_set.contains(&edge.target);

            if source_in && target_in {
                // Direct edge: both endpoints rendered.
                edges.push(edge.clone());
                continue;
            }

            // At least one endpoint is hidden -- lift to nearest rendered ancestor.
            let lifted_source =
                match find_render_ancestor(&edge.source, &render_set, &parent_map) {
                    Some(id) => id,
                    None => continue,
                };
            let lifted_target =
                match find_render_ancestor(&edge.target, &render_set, &parent_map) {
                    Some(id) => id,
                    None => continue,
                };

            // Skip self-loops (both endpoints resolve to the same container).
            if lifted_source == lifted_target {
                continue;
            }

            // Skip when one lifted endpoint is an ancestor of the other -- an
            // edge from a node into its own containing box is misleading.
            if is_ancestor_of(lifted_source, lifted_target, &parent_map)
                || is_ancestor_of(lifted_target, lifted_source, &parent_map)
            {
                continue;
            }

            let key = (lifted_source.clone(), lifted_target.clone());
            match agg_map.get_mut(&key) {
                Some(agg) => {
                    agg.count = agg.count.saturating_add(1);
                }
                None => {
                    agg_order.push(key.clone());
                    agg_map.insert(
                        key,
                        AggregatedEdge {
                            source: lifted_source.clone(),
                            target: lifted_target.clone(),
                            kind: edge.kind.clone(),
                            count: 1,
                        },
                    );
                }
            }
        }

        let aggregated_edges: Vec<AggregatedEdge> = agg_order
            .into_iter()
            .filter_map(|key| agg_map.remove(&key))
            .collect();

        SubGraph {
            edges,
            aggregated_edges,
        }
    }
}

/// The edge-less parse response sent over IPC.
///
/// The full graph (nodes + edges) stays in server-side state; the frontend
/// receives the node tree once plus a compact connectivity map so it can run
/// the `hideUnconnectedNodes` filter synchronously without holding edges.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseResult {
    pub nodes: HashMap<NodeId, CodeNode>,
    pub root: NodeId,
    pub edge_count: usize,
    /// For each node touched by at least one edge, the distinct edge kinds that
    /// touch it (as either source or target).
    pub node_edge_kinds: HashMap<NodeId, Vec<EdgeKind>>,
}

impl ParseResult {
    /// Build an edge-less parse result from a fully-parsed graph.
    pub fn from_graph(graph: &CodeGraph) -> Self {
        ParseResult {
            nodes: graph.nodes.clone(),
            root: graph.root.clone(),
            edge_count: graph.edges.len(),
            node_edge_kinds: build_node_edge_kinds(graph),
        }
    }
}

/// Build the per-node connectivity map: for every node id that is an endpoint of
/// at least one edge, record the distinct edge kinds touching it. Deterministic
/// kind ordering (by discriminant) so output is stable.
pub fn build_node_edge_kinds(graph: &CodeGraph) -> HashMap<NodeId, Vec<EdgeKind>> {
    let mut kinds_by_node: HashMap<NodeId, HashSet<EdgeKind>> = HashMap::new();

    for edge in graph.edges.iter() {
        kinds_by_node
            .entry(edge.source.clone())
            .or_default()
            .insert(edge.kind.clone());
        kinds_by_node
            .entry(edge.target.clone())
            .or_default()
            .insert(edge.kind.clone());
    }

    kinds_by_node
        .into_iter()
        .map(|(node_id, kind_set)| {
            let mut kinds: Vec<EdgeKind> = kind_set.into_iter().collect();
            kinds.sort_by_key(|k| k.discriminant());
            (node_id, kinds)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_edge_merges_duplicates_by_kind_and_endpoint_pair() {
        let mut graph = CodeGraph::new(NodeId("root".into()));

        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::FunctionCall,
            weight: 1,
        });
        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::FunctionCall,
            weight: 1,
        });
        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::MethodCall,
            weight: 1,
        });

        assert_eq!(graph.edges.len(), 2);
        assert_eq!(graph.forward_adj.get(&NodeId("a".into())).unwrap().len(), 2);
        assert_eq!(graph.reverse_adj.get(&NodeId("b".into())).unwrap().len(), 2);

        let function_call = graph
            .edges
            .iter()
            .find(|edge| edge.kind == EdgeKind::FunctionCall)
            .unwrap();
        assert_eq!(function_call.weight, 2);
    }

    #[test]
    fn test_add_1000_unique_edges() {
        let mut graph = CodeGraph::new(NodeId("root".into()));
        for i in 0..1000 {
            graph.add_edge(CodeEdge {
                source: NodeId(format!("src_{}", i)),
                target: NodeId(format!("tgt_{}", i)),
                kind: EdgeKind::FunctionCall,
                weight: 1,
            });
        }
        assert_eq!(graph.edge_count(), 1000);
        assert_eq!(graph.edges.len(), 1000);
    }

    #[test]
    fn test_edge_index_consistency() {
        let mut graph = CodeGraph::new(NodeId("root".into()));

        // Add 10 unique edges
        for i in 0..10 {
            graph.add_edge(CodeEdge {
                source: NodeId(format!("a_{}", i)),
                target: NodeId(format!("b_{}", i)),
                kind: EdgeKind::Import,
                weight: 1,
            });
        }

        // Add 5 duplicates of existing edges
        for i in 0..5 {
            graph.add_edge(CodeEdge {
                source: NodeId(format!("a_{}", i)),
                target: NodeId(format!("b_{}", i)),
                kind: EdgeKind::Import,
                weight: 1,
            });
        }

        // Add 3 edges with same endpoints but different kind
        for i in 0..3 {
            graph.add_edge(CodeEdge {
                source: NodeId(format!("a_{}", i)),
                target: NodeId(format!("b_{}", i)),
                kind: EdgeKind::MethodCall,
                weight: 1,
            });
        }

        // 10 unique Import edges + 3 unique MethodCall edges = 13
        assert_eq!(graph.edges.len(), 13);
        assert_eq!(graph.edge_index.len(), 13);

        // Verify the first 5 Import edges have weight 2 (original + duplicate)
        for i in 0..5 {
            let src = NodeId(format!("a_{}", i));
            let tgt = NodeId(format!("b_{}", i));
            let idx = graph.edge_index.get(&src, &tgt, &EdgeKind::Import).unwrap();
            assert_eq!(graph.edges[idx].weight, 2);
        }

        // Verify the last 5 Import edges have weight 1
        for i in 5..10 {
            let src = NodeId(format!("a_{}", i));
            let tgt = NodeId(format!("b_{}", i));
            let idx = graph.edge_index.get(&src, &tgt, &EdgeKind::Import).unwrap();
            assert_eq!(graph.edges[idx].weight, 1);
        }
    }

    #[test]
    fn test_add_edge_weight_accumulation() {
        let mut graph = CodeGraph::new(NodeId("root".into()));

        for _ in 0..5 {
            graph.add_edge(CodeEdge {
                source: NodeId("x".into()),
                target: NodeId("y".into()),
                kind: EdgeKind::FunctionCall,
                weight: 1,
            });
        }

        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].weight, 5);
        assert_eq!(graph.edge_index.len(), 1);
    }

    #[test]
    fn test_edge_index_rebuild_matches_inserts() {
        // Build a graph by adding edges one-by-one
        let mut graph_incremental = CodeGraph::new(NodeId("root".into()));
        let edges: Vec<CodeEdge> = (0..50)
            .map(|i| CodeEdge {
                source: NodeId(format!("src_{}", i)),
                target: NodeId(format!("tgt_{}", i)),
                kind: if i % 3 == 0 {
                    EdgeKind::Import
                } else if i % 3 == 1 {
                    EdgeKind::FunctionCall
                } else {
                    EdgeKind::MethodCall
                },
                weight: 1,
            })
            .collect();

        for edge in &edges {
            graph_incremental.add_edge(edge.clone());
        }

        // Build another graph by pushing edges directly, then calling rebuild_adjacency
        let mut graph_bulk = CodeGraph::new(NodeId("root".into()));
        for edge in &edges {
            graph_bulk.edges.push(edge.clone());
        }
        graph_bulk.rebuild_adjacency();

        // Assert both graphs have the same edge count
        assert_eq!(graph_incremental.edge_count(), graph_bulk.edge_count());

        // Assert both graphs have the same edges (same source/target/kind triples)
        for edge in &graph_incremental.edges {
            let found = graph_bulk.edges.iter().any(|e| {
                e.source == edge.source && e.target == edge.target && e.kind == edge.kind
            });
            assert!(
                found,
                "Edge ({}, {}, {:?}) present in incremental but missing in bulk",
                edge.source, edge.target, edge.kind
            );
        }
    }

    #[test]
    fn test_add_edge_updates_index_on_merge() {
        let mut graph = CodeGraph::new(NodeId("root".into()));

        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::Import,
            weight: 3,
        });
        // Add the same edge again
        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::Import,
            weight: 7,
        });

        // Edge count should still be 1
        assert_eq!(graph.edge_count(), 1);
        // Weight should be summed
        assert_eq!(graph.edges[0].weight, 10);
    }

    #[test]
    fn test_large_graph_no_duplicate_edges() {
        use std::collections::HashSet;

        let mut graph = CodeGraph::new(NodeId("root".into()));
        let mut unique_keys: HashSet<(String, String, String)> = HashSet::new();

        for i in 0..1000 {
            // 20% of edges are duplicates: indices 0,5,10,... map to a small set
            let (src, tgt, kind) = if i % 5 == 0 {
                let hot = i % 50;
                (
                    format!("hot_src_{}", hot),
                    format!("hot_tgt_{}", hot),
                    EdgeKind::FunctionCall,
                )
            } else {
                (
                    format!("src_{}", i),
                    format!("tgt_{}", i),
                    EdgeKind::Import,
                )
            };

            unique_keys.insert((src.clone(), tgt.clone(), format!("{:?}", kind)));

            graph.add_edge(CodeEdge {
                source: NodeId(src),
                target: NodeId(tgt),
                kind,
                weight: 1,
            });
        }

        // The final edge count must equal the number of unique (source, target, kind) combos
        assert_eq!(graph.edge_count(), unique_keys.len());
    }

    // --- SubGraph aggregation parity + ParseResult connectivity tests ---

    use crate::model::{BlockKind, Span, Visibility};

    fn dir(id: &str, children: Vec<&str>) -> CodeNode {
        CodeNode::Directory {
            id: NodeId(id.into()),
            name: id.into(),
            path: id.into(),
            children: children.into_iter().map(|c| NodeId(c.into())).collect(),
        }
    }

    fn file(id: &str, parent_children: Vec<&str>) -> CodeNode {
        CodeNode::File {
            id: NodeId(id.into()),
            name: id.into(),
            path: id.into(),
            language: Some(crate::model::Language::Python),
            children: parent_children
                .into_iter()
                .map(|c| NodeId(c.into()))
                .collect(),
        }
    }

    fn block(id: &str, parent: &str) -> CodeNode {
        CodeNode::CodeBlock {
            id: NodeId(id.into()),
            name: id.into(),
            kind: BlockKind::Function,
            span: Span {
                start_line: 1,
                start_col: 0,
                end_line: 1,
                end_col: 0,
            },
            signature: None,
            visibility: Some(Visibility::Public),
            parent: NodeId(parent.into()),
            children: Vec::new(),
        }
    }

    /// Build a graph:
    /// root -> [fileA, fileB]
    /// fileA -> [fnA1, fnA2]
    /// fileB -> [fnB1]
    fn sample_graph() -> CodeGraph {
        let mut g = CodeGraph::new(NodeId("root".into()));
        g.add_node(dir("root", vec!["fileA", "fileB"]));
        g.add_node(file("fileA", vec!["fnA1", "fnA2"]));
        g.add_node(file("fileB", vec!["fnB1"]));
        g.add_node(block("fnA1", "fileA"));
        g.add_node(block("fnA2", "fileA"));
        g.add_node(block("fnB1", "fileB"));
        g
    }

    fn all_kinds() -> HashSet<EdgeKind> {
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

    fn edge(src: &str, tgt: &str, kind: EdgeKind) -> CodeEdge {
        CodeEdge {
            source: NodeId(src.into()),
            target: NodeId(tgt.into()),
            kind,
            weight: 1,
        }
    }

    #[test]
    fn subgraph_direct_edge_when_both_endpoints_rendered() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));

        let render: Vec<NodeId> = ["fnA1", "fnB1"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 1);
        assert_eq!(sub.aggregated_edges.len(), 0);
        assert_eq!(sub.edges[0].source, NodeId("fnA1".into()));
        assert_eq!(sub.edges[0].target, NodeId("fnB1".into()));
    }

    #[test]
    fn subgraph_lifts_hidden_endpoint_to_rendered_ancestor() {
        let mut g = sample_graph();
        // Edge between two blocks; only the files are rendered.
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));

        let render: Vec<NodeId> = ["fileA", "fileB"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 0);
        assert_eq!(sub.aggregated_edges.len(), 1);
        let agg = &sub.aggregated_edges[0];
        assert_eq!(agg.source, NodeId("fileA".into()));
        assert_eq!(agg.target, NodeId("fileB".into()));
        assert_eq!(agg.count, 1);
    }

    #[test]
    fn subgraph_skips_self_loop_after_lifting() {
        let mut g = sample_graph();
        // Two blocks in the same file; only fileA is rendered -> both lift to fileA.
        g.add_edge(edge("fnA1", "fnA2", EdgeKind::FunctionCall));

        let render: Vec<NodeId> = ["fileA", "fileB"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 0);
        assert_eq!(sub.aggregated_edges.len(), 0);
    }

    #[test]
    fn subgraph_skips_ancestor_containment() {
        // Edge fnA1 -> fnA2 (both children of fileA). Render fileA (ancestor)
        // and fnA2 (descendant of fileA). fnA1 lifts to fileA; fnA2 is rendered.
        // fileA is an ancestor of fnA2 -> containment -> skip.
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnA2", EdgeKind::FunctionCall));
        let render: Vec<NodeId> = ["fileA", "fnA2"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 0);
        assert_eq!(sub.aggregated_edges.len(), 0);
    }

    #[test]
    fn subgraph_filters_disabled_kinds() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::Import));

        let render: Vec<NodeId> = ["fnA1", "fnB1"].iter().map(|s| NodeId(s.to_string())).collect();
        let only_import: HashSet<EdgeKind> = [EdgeKind::Import].into_iter().collect();
        let sub = SubGraph::from_graph(&g, &render, &only_import);

        assert_eq!(sub.edges.len(), 1);
        assert_eq!(sub.edges[0].kind, EdgeKind::Import);
    }

    #[test]
    fn subgraph_dedups_aggregated_edges_and_counts() {
        let mut g = sample_graph();
        // Two distinct block-level edges both lifting to fileA -> fileB.
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA2", "fnB1", EdgeKind::Import));

        let render: Vec<NodeId> = ["fileA", "fileB"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.aggregated_edges.len(), 1);
        let agg = &sub.aggregated_edges[0];
        assert_eq!(agg.source, NodeId("fileA".into()));
        assert_eq!(agg.target, NodeId("fileB".into()));
        assert_eq!(agg.count, 2);
        // First kind seen (FunctionCall) is retained.
        assert_eq!(agg.kind, EdgeKind::FunctionCall);
    }

    #[test]
    fn subgraph_skips_unresolvable_endpoint() {
        let mut g = sample_graph();
        // Edge to a node id that isn't in the graph -> parent chain resolves to
        // None -> skip.
        g.edges.push(edge("fnA1", "ghost", EdgeKind::FunctionCall));
        g.rebuild_adjacency();

        let render: Vec<NodeId> = ["fileA", "fileB"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 0);
        assert_eq!(sub.aggregated_edges.len(), 0);
    }

    #[test]
    fn build_node_edge_kinds_records_distinct_kinds_per_endpoint() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::Import));
        g.add_edge(edge("fnA2", "fnB1", EdgeKind::MethodCall));

        let map = build_node_edge_kinds(&g);

        // fnA1 touched by FunctionCall + Import.
        let fn_a1 = map.get(&NodeId("fnA1".into())).unwrap();
        assert_eq!(fn_a1, &vec![EdgeKind::Import, EdgeKind::FunctionCall]);
        // fnB1 touched by all three (sorted by discriminant).
        let fn_b1 = map.get(&NodeId("fnB1".into())).unwrap();
        assert_eq!(
            fn_b1,
            &vec![EdgeKind::Import, EdgeKind::FunctionCall, EdgeKind::MethodCall]
        );
        // A node with no edges is absent from the map.
        assert!(map.get(&NodeId("fileA".into())).is_none());
    }

    #[test]
    fn parse_result_from_graph_is_edge_less_with_connectivity() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));

        let result = ParseResult::from_graph(&g);
        assert_eq!(result.edge_count, 1);
        assert_eq!(result.root, NodeId("root".into()));
        assert_eq!(result.nodes.len(), g.nodes.len());
        assert!(result.node_edge_kinds.contains_key(&NodeId("fnA1".into())));
        assert!(result.node_edge_kinds.contains_key(&NodeId("fnB1".into())));
    }
}
