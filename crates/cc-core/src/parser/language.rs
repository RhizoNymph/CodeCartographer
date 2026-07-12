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

    /// Collect raw references (imports, calls, type refs) from a single
    /// tree-sitter node. The extractor drives the walk and calls this once per
    /// node, so implementations must inspect only the given node (they may still
    /// look at the node's own parent/children, but must not recurse the subtree).
    /// References are attributed to `from_id`, the innermost enclosing block.
    fn collect_node_references(
        &self,
        source: &str,
        node: &Node,
        from_id: &NodeId,
        refs: &mut Vec<RawReference>,
    );

    /// Return the tree-sitter Language for parsing.
    fn tree_sitter_language(&self) -> tree_sitter::Language;
}
