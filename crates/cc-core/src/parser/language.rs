use tree_sitter::Node;

use crate::model::{BlockKind, NodeId, Visibility};

use super::extract::RawReference;

/// Trait for language-specific code classification and reference collection.
pub trait LanguageSupport {
    /// Classify a tree-sitter node into a code block kind, name, and optional visibility.
    /// Returns None if the node is not a recognized code construct.
    fn classify_node(
        &self,
        kind: &str,
        node: &Node,
        source: &str,
    ) -> Option<(BlockKind, String, Option<Visibility>)>;

    /// Collect raw references (imports, calls, type refs) from a tree-sitter subtree.
    fn collect_references(
        &self,
        source: &str,
        root: &Node,
        from_id: &NodeId,
        refs: &mut Vec<RawReference>,
    );

    /// Return the tree-sitter Language for parsing.
    fn tree_sitter_language(&self) -> tree_sitter::Language;
}
