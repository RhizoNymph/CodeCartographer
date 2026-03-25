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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BlockKind, CodeGraph, CodeNode, EdgeKind, NodeId, Span};
    use crate::parser::{RawRefKind, RawReference};

    fn make_span() -> Span {
        Span {
            start_line: 1,
            start_col: 0,
            end_line: 1,
            end_col: 10,
        }
    }

    /// Build a simple graph with a file node and code block children.
    fn build_test_graph() -> CodeGraph {
        let root_id = NodeId::directory("");
        let file_id = NodeId::file("src/main.py");
        let block_a_id = NodeId::code_block("src/main.py", "alpha", 1);
        let block_b_id = NodeId::code_block("src/main.py", "beta", 5);

        let mut graph = CodeGraph::new(root_id.clone());

        graph.add_node(CodeNode::Directory {
            id: root_id,
            name: "root".to_string(),
            path: String::new(),
            children: vec![file_id.clone()],
        });

        graph.add_node(CodeNode::File {
            id: file_id.clone(),
            name: "main.py".to_string(),
            path: "src/main.py".to_string(),
            language: None,
            children: vec![block_a_id.clone(), block_b_id.clone()],
        });

        graph.add_node(CodeNode::CodeBlock {
            id: block_a_id,
            name: "alpha".to_string(),
            kind: BlockKind::Function,
            span: make_span(),
            signature: Some("def alpha():".to_string()),
            visibility: Some(crate::model::Visibility::Public),
            parent: file_id.clone(),
            children: Vec::new(),
        });

        graph.add_node(CodeNode::CodeBlock {
            id: block_b_id,
            name: "beta".to_string(),
            kind: BlockKind::Function,
            span: make_span(),
            signature: Some("def beta():".to_string()),
            visibility: Some(crate::model::Visibility::Public),
            parent: file_id,
            children: Vec::new(),
        });

        graph
    }

    #[test]
    fn test_build_from_graph_registers_code_blocks() {
        let graph = build_test_graph();
        let table = SymbolTable::build_from_graph(&graph);

        // Both short names should be registered
        assert!(
            table.symbols.contains_key("alpha"),
            "symbol table should contain 'alpha'"
        );
        assert!(
            table.symbols.contains_key("beta"),
            "symbol table should contain 'beta'"
        );

        // FQNs should also be registered
        assert!(
            table.symbols.contains_key("src/main.py::alpha"),
            "symbol table should contain FQN 'src/main.py::alpha'"
        );
        assert!(
            table.symbols.contains_key("src/main.py::beta"),
            "symbol table should contain FQN 'src/main.py::beta'"
        );
    }

    #[test]
    fn test_build_from_graph_skips_directories_and_files() {
        let graph = build_test_graph();
        let table = SymbolTable::build_from_graph(&graph);

        // Directory and file names/paths should NOT appear as symbol keys
        // (only CodeBlock nodes are registered)
        for key in table.symbols.keys() {
            // The symbol keys should reference the code block names or FQNs,
            // not plain directory/file entries
            assert!(
                key == "alpha"
                    || key == "beta"
                    || key.contains("::alpha")
                    || key.contains("::beta"),
                "unexpected symbol key: '{}'",
                key,
            );
        }
    }

    #[test]
    fn test_resolve_creates_edges() {
        let graph = build_test_graph();
        let table = SymbolTable::build_from_graph(&graph);

        let block_a_id = NodeId::code_block("src/main.py", "alpha", 1);
        let block_b_id = NodeId::code_block("src/main.py", "beta", 5);

        // alpha calls beta
        let refs = vec![RawReference {
            from_node: block_a_id.clone(),
            kind: RawRefKind::FunctionCall,
            name: "beta".to_string(),
            span: make_span(),
        }];

        let edges = table.resolve_references(&refs);
        assert!(!edges.is_empty(), "expected at least one resolved edge");

        let edge = edges
            .iter()
            .find(|e| e.source == block_a_id && e.target == block_b_id)
            .expect("expected edge from alpha to beta");
        assert_eq!(edge.kind, EdgeKind::FunctionCall);
    }

    #[test]
    fn test_resolve_skips_self_edges() {
        let graph = build_test_graph();
        let table = SymbolTable::build_from_graph(&graph);

        let block_a_id = NodeId::code_block("src/main.py", "alpha", 1);

        // alpha references itself
        let refs = vec![RawReference {
            from_node: block_a_id.clone(),
            kind: RawRefKind::FunctionCall,
            name: "alpha".to_string(),
            span: make_span(),
        }];

        let edges = table.resolve_references(&refs);
        assert!(
            edges.iter().all(|e| e.source != e.target),
            "self-edges should not be produced"
        );
    }

    #[test]
    fn test_resolve_handles_ambiguous_names() {
        // Two code blocks named "foo" in different files
        let root_id = NodeId::directory("");
        let file1_id = NodeId::file("a.py");
        let file2_id = NodeId::file("b.py");
        let foo1_id = NodeId::code_block("a.py", "foo", 1);
        let foo2_id = NodeId::code_block("b.py", "foo", 1);
        let caller_id = NodeId::code_block("c.py", "caller", 1);
        let file3_id = NodeId::file("c.py");

        let mut graph = CodeGraph::new(root_id.clone());
        graph.add_node(CodeNode::Directory {
            id: root_id,
            name: "root".to_string(),
            path: String::new(),
            children: vec![file1_id.clone(), file2_id.clone(), file3_id.clone()],
        });
        graph.add_node(CodeNode::File {
            id: file1_id.clone(),
            name: "a.py".to_string(),
            path: "a.py".to_string(),
            language: None,
            children: vec![foo1_id.clone()],
        });
        graph.add_node(CodeNode::File {
            id: file2_id.clone(),
            name: "b.py".to_string(),
            path: "b.py".to_string(),
            language: None,
            children: vec![foo2_id.clone()],
        });
        graph.add_node(CodeNode::File {
            id: file3_id.clone(),
            name: "c.py".to_string(),
            path: "c.py".to_string(),
            language: None,
            children: vec![caller_id.clone()],
        });
        graph.add_node(CodeNode::CodeBlock {
            id: foo1_id.clone(),
            name: "foo".to_string(),
            kind: BlockKind::Function,
            span: make_span(),
            signature: None,
            visibility: None,
            parent: file1_id,
            children: Vec::new(),
        });
        graph.add_node(CodeNode::CodeBlock {
            id: foo2_id.clone(),
            name: "foo".to_string(),
            kind: BlockKind::Function,
            span: make_span(),
            signature: None,
            visibility: None,
            parent: file2_id,
            children: Vec::new(),
        });
        graph.add_node(CodeNode::CodeBlock {
            id: caller_id.clone(),
            name: "caller".to_string(),
            kind: BlockKind::Function,
            span: make_span(),
            signature: None,
            visibility: None,
            parent: file3_id,
            children: Vec::new(),
        });

        let table = SymbolTable::build_from_graph(&graph);

        let refs = vec![RawReference {
            from_node: caller_id.clone(),
            kind: RawRefKind::FunctionCall,
            name: "foo".to_string(),
            span: make_span(),
        }];

        let edges = table.resolve_references(&refs);
        // Should produce edges to BOTH foo1 and foo2
        let targets: Vec<_> = edges.iter().map(|e| e.target.clone()).collect();
        assert!(
            targets.contains(&foo1_id),
            "expected edge to foo in a.py"
        );
        assert!(
            targets.contains(&foo2_id),
            "expected edge to foo in b.py"
        );
    }

    #[test]
    fn test_get_file_path_walks_parent_chain() {
        // Code block nested inside another code block, verify file path resolution
        let root_id = NodeId::directory("");
        let file_id = NodeId::file("lib.rs");
        let outer_id = NodeId::code_block("lib.rs", "outer", 1);
        let inner_id = NodeId::code_block("lib.rs", "inner", 5);

        let mut graph = CodeGraph::new(root_id.clone());
        graph.add_node(CodeNode::Directory {
            id: root_id,
            name: "root".to_string(),
            path: String::new(),
            children: vec![file_id.clone()],
        });
        graph.add_node(CodeNode::File {
            id: file_id.clone(),
            name: "lib.rs".to_string(),
            path: "lib.rs".to_string(),
            language: None,
            children: vec![outer_id.clone()],
        });
        graph.add_node(CodeNode::CodeBlock {
            id: outer_id.clone(),
            name: "outer".to_string(),
            kind: BlockKind::Function,
            span: make_span(),
            signature: None,
            visibility: None,
            parent: file_id,
            children: vec![inner_id.clone()],
        });
        graph.add_node(CodeNode::CodeBlock {
            id: inner_id.clone(),
            name: "inner".to_string(),
            kind: BlockKind::Function,
            span: make_span(),
            signature: None,
            visibility: None,
            parent: outer_id,
            children: Vec::new(),
        });

        // Build the table - the inner block's FQN should reference the file path
        let table = SymbolTable::build_from_graph(&graph);

        // inner's FQN should be "lib.rs::inner" (walked through outer to file)
        assert!(
            table.symbols.contains_key("lib.rs::inner"),
            "inner block FQN should resolve to 'lib.rs::inner' by walking parent chain"
        );
    }
}
