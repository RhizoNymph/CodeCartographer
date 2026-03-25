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
                table.symbols.entry(fqn).or_default().push(id.clone());
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
    ///
    /// Applies name normalization before lookup:
    /// - FunctionCall/MethodCall: strips method receiver (`foo.bar()` -> `bar`)
    ///   and module path (`module::func` -> `func`)
    /// - TypeReference/Inheritance/TraitImpl: strips generic params (`Foo<Bar>` -> `Foo`)
    ///   and path prefix (`std::collections::HashMap` -> `HashMap`)
    pub fn resolve_references(&self, refs: &[RawReference]) -> Vec<CodeEdge> {
        let mut edges = Vec::new();

        for raw_ref in refs {
            let (kind, lookup_name) = match &raw_ref.kind {
                crate::parser::RawRefKind::Import { .. } => {
                    (EdgeKind::Import, raw_ref.name.clone())
                }
                crate::parser::RawRefKind::FunctionCall | crate::parser::RawRefKind::MethodCall => {
                    let kind = match &raw_ref.kind {
                        crate::parser::RawRefKind::FunctionCall => EdgeKind::FunctionCall,
                        crate::parser::RawRefKind::MethodCall => EdgeKind::MethodCall,
                        _ => unreachable!(),
                    };
                    // Strip method receiver: "foo.bar()" -> "bar"
                    let name = if raw_ref.name.contains('.') {
                        raw_ref.name.rsplit('.').next().unwrap_or(&raw_ref.name)
                    } else {
                        raw_ref.name.as_str()
                    };
                    // Strip module path: "module::func" -> "func"
                    let name = if name.contains("::") {
                        name.rsplit("::").next().unwrap_or(name)
                    } else {
                        name
                    };
                    (kind, name.to_string())
                }
                crate::parser::RawRefKind::TypeReference
                | crate::parser::RawRefKind::Inheritance
                | crate::parser::RawRefKind::TraitImpl => {
                    let kind = match &raw_ref.kind {
                        crate::parser::RawRefKind::TypeReference => EdgeKind::TypeReference,
                        crate::parser::RawRefKind::Inheritance => EdgeKind::Inheritance,
                        crate::parser::RawRefKind::TraitImpl => EdgeKind::TraitImpl,
                        _ => unreachable!(),
                    };
                    // Strip generic parameters: "Foo<Bar>" -> "Foo"
                    let name = if let Some(idx) = raw_ref.name.find('<') {
                        &raw_ref.name[..idx]
                    } else {
                        raw_ref.name.as_str()
                    };
                    // Strip path prefix: "std::collections::HashMap" -> "HashMap"
                    let name = name.rsplit("::").next().unwrap_or(name);
                    (kind, name.to_string())
                }
                crate::parser::RawRefKind::VariableUsage => {
                    (EdgeKind::VariableUsage, raw_ref.name.clone())
                }
            };

            // Try the normalized name first, then fall back to full qualified name for types
            let targets = self.symbols.get(&lookup_name).or_else(|| {
                // For type references, also try the original name in case it's fully qualified
                match &raw_ref.kind {
                    crate::parser::RawRefKind::TypeReference
                    | crate::parser::RawRefKind::Inheritance
                    | crate::parser::RawRefKind::TraitImpl => {
                        if lookup_name != raw_ref.name {
                            self.symbols.get(&raw_ref.name)
                        } else {
                            None
                        }
                    }
                    _ => None,
                }
            });

            if let Some(targets) = targets {
                for target in targets {
                    if *target != raw_ref.from_node {
                        edges.push(CodeEdge {
                            source: raw_ref.from_node.clone(),
                            target: target.clone(),
                            kind: kind.clone(),
                            weight: 1,
                        });
                    }
                }
            }
        }

        edges
    }
}
