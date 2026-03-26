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
}

/// A filtered subgraph for frontend rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubGraph {
    pub nodes: Vec<CodeNode>,
    pub edges: Vec<CodeEdge>,
    pub aggregated_edges: Vec<AggregatedEdge>,
}

impl SubGraph {
    /// Extract a subgraph with only the visible nodes and relevant edges.
    pub fn from_graph(
        graph: &CodeGraph,
        visible_ids: &[NodeId],
        enabled_edge_kinds: &HashSet<EdgeKind>,
    ) -> Self {
        let visible_set: HashSet<&NodeId> = visible_ids.iter().collect();

        let nodes: Vec<CodeNode> = visible_ids
            .iter()
            .filter_map(|id| graph.nodes.get(id).cloned())
            .collect();

        let edges: Vec<CodeEdge> = graph
            .edges
            .iter()
            .filter(|e| {
                visible_set.contains(&e.source)
                    && visible_set.contains(&e.target)
                    && enabled_edge_kinds.contains(&e.kind)
            })
            .cloned()
            .collect();

        // TODO: compute aggregated edges for collapsed containers

        SubGraph {
            nodes,
            edges,
            aggregated_edges: Vec::new(),
        }
    }
}
