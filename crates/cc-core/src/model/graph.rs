use std::collections::HashMap;

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
}

impl CodeGraph {
    pub fn new(root_id: NodeId) -> Self {
        Self {
            nodes: HashMap::new(),
            edges: Vec::new(),
            root: root_id,
            forward_adj: HashMap::new(),
            reverse_adj: HashMap::new(),
        }
    }

    pub fn add_node(&mut self, node: CodeNode) {
        self.nodes.insert(node.id().clone(), node);
    }

    pub fn add_edge(&mut self, edge: CodeEdge) {
        let idx = self.edges.len();
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
        enabled_edge_kinds: &[EdgeKind],
    ) -> Self {
        let visible_set: std::collections::HashSet<&NodeId> = visible_ids.iter().collect();

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
