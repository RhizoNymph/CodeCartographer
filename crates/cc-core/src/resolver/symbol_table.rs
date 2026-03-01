use std::collections::HashMap;

use crate::model::{CodeEdge, CodeGraph, CodeNode, EdgeKind, NodeId};
use crate::parser::RawReference;

/// Maps symbol names to their defining NodeIds for cross-file resolution.
#[derive(Debug, Default)]
pub struct SymbolTable {
    /// Fully-qualified name -> NodeId
    pub symbols: HashMap<String, Vec<NodeId>>,
    /// File path -> exported symbols
    pub exports: HashMap<String, Vec<String>>,
}

impl SymbolTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build the symbol table from the code graph.
    pub fn build_from_graph(graph: &CodeGraph) -> Self {
        let mut table = Self::new();

        for (id, node) in &graph.nodes {
            if let CodeNode::CodeBlock { name, parent, .. } = node {
                // Get file path for fully-qualified name
                let file_path = Self::get_file_path(graph, parent);
                let fqn = format!("{}::{}", file_path, name);
                table
                    .symbols
                    .entry(name.clone())
                    .or_default()
                    .push(id.clone());
                table
                    .symbols
                    .entry(fqn)
                    .or_default()
                    .push(id.clone());
            }
        }

        table
    }

    fn get_file_path(graph: &CodeGraph, id: &NodeId) -> String {
        match graph.nodes.get(id) {
            Some(CodeNode::File { path, .. }) => path.clone(),
            Some(CodeNode::CodeBlock { parent, .. }) => Self::get_file_path(graph, parent),
            _ => id.0.clone(),
        }
    }

    /// Resolve raw references into edges.
    pub fn resolve_references(
        &self,
        refs: &[RawReference],
    ) -> Vec<CodeEdge> {
        let mut edges = Vec::new();

        for raw_ref in refs {
            if let Some(targets) = self.symbols.get(&raw_ref.name) {
                for target in targets {
                    if *target != raw_ref.from_node {
                        let kind = match &raw_ref.kind {
                            crate::parser::RawRefKind::Import { .. } => EdgeKind::Import,
                            crate::parser::RawRefKind::FunctionCall => EdgeKind::FunctionCall,
                            crate::parser::RawRefKind::MethodCall => EdgeKind::MethodCall,
                            crate::parser::RawRefKind::TypeReference => EdgeKind::TypeReference,
                            crate::parser::RawRefKind::Inheritance => EdgeKind::Inheritance,
                            crate::parser::RawRefKind::TraitImpl => EdgeKind::TraitImpl,
                            crate::parser::RawRefKind::VariableUsage => EdgeKind::VariableUsage,
                        };

                        edges.push(CodeEdge {
                            source: raw_ref.from_node.clone(),
                            target: target.clone(),
                            kind,
                            weight: 1,
                        });
                    }
                }
            }
        }

        edges
    }
}
