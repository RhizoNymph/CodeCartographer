use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

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
    pub edge_dedup: HashMap<(NodeId, NodeId, EdgeKind), usize>,
}

impl CodeGraph {
    pub fn new(root_id: NodeId) -> Self {
        Self {
            nodes: HashMap::new(),
            edges: Vec::new(),
            root: root_id,
            forward_adj: HashMap::new(),
            reverse_adj: HashMap::new(),
            edge_dedup: HashMap::new(),
        }
    }

    pub fn add_node(&mut self, node: CodeNode) {
        self.nodes.insert(node.id().clone(), node);
    }

    pub fn add_edge(&mut self, edge: CodeEdge) {
        let key = (edge.source.clone(), edge.target.clone(), edge.kind.clone());
        if let Some(&idx) = self.edge_dedup.get(&key) {
            self.edges[idx].weight = self.edges[idx].weight.saturating_add(edge.weight);
            return;
        }
        let idx = self.edges.len();
        self.edge_dedup.insert(key, idx);
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
        self.edge_dedup.clear();
        for (idx, edge) in self.edges.iter().enumerate() {
            self.forward_adj
                .entry(edge.source.clone())
                .or_default()
                .push((edge.target.clone(), idx));
            self.reverse_adj
                .entry(edge.target.clone())
                .or_default()
                .push((edge.source.clone(), idx));
            self.edge_dedup.insert(
                (edge.source.clone(), edge.target.clone(), edge.kind.clone()),
                idx,
            );
        }
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
        assert_eq!(graph.edge_dedup.len(), 13);

        // Verify the first 5 Import edges have weight 2 (original + duplicate)
        for i in 0..5 {
            let key = (
                NodeId(format!("a_{}", i)),
                NodeId(format!("b_{}", i)),
                EdgeKind::Import,
            );
            let &idx = graph.edge_dedup.get(&key).unwrap();
            assert_eq!(graph.edges[idx].weight, 2);
        }

        // Verify the last 5 Import edges have weight 1
        for i in 5..10 {
            let key = (
                NodeId(format!("a_{}", i)),
                NodeId(format!("b_{}", i)),
                EdgeKind::Import,
            );
            let &idx = graph.edge_dedup.get(&key).unwrap();
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
        assert_eq!(graph.edge_dedup.len(), 1);
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
