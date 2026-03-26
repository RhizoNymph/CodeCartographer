use std::collections::HashMap;

use super::{EdgeKind, NodeId};

/// HashMap-backed index for O(1) amortized edge deduplication.
///
/// Maps `(source, target, kind)` triples to their index in the `edges` Vec
/// of [`super::CodeGraph`].  This replaces a bare `HashMap` field on the
/// graph struct so that the dedup logic lives in a focused, testable module.
#[derive(Debug, Default, Clone)]
pub struct EdgeIndex {
    dedup: HashMap<(NodeId, NodeId, EdgeKind), usize>,
}

impl EdgeIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up the edge-vec index for the given `(source, target, kind)` triple.
    pub fn get(&self, source: &NodeId, target: &NodeId, kind: &EdgeKind) -> Option<usize> {
        self.dedup
            .get(&(source.clone(), target.clone(), kind.clone()))
            .copied()
    }

    /// Record a new edge's position in the edge vec.
    pub fn insert(&mut self, source: NodeId, target: NodeId, kind: EdgeKind, index: usize) {
        self.dedup.insert((source, target, kind), index);
    }

    /// Remove all entries.
    pub fn clear(&mut self) {
        self.dedup.clear();
    }

    /// Number of entries currently tracked.
    pub fn len(&self) -> usize {
        self.dedup.len()
    }

    /// Whether the index is empty.
    pub fn is_empty(&self) -> bool {
        self.dedup.is_empty()
    }

    /// Rebuild the entire index from the authoritative `edges` vec.
    pub fn rebuild(&mut self, edges: &[super::CodeEdge]) {
        self.dedup.clear();
        for (i, edge) in edges.iter().enumerate() {
            self.dedup.insert(
                (edge.source.clone(), edge.target.clone(), edge.kind.clone()),
                i,
            );
        }
    }
}
