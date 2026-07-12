use std::collections::{HashMap, HashSet};

use crate::model::{CodeEdge, CodeGraph, CodeNode, EdgeKind, NodeId, Resolution};
use crate::parser::RawReference;

use super::import_resolver::ImportMap;

/// Maximum number of candidate edges emitted for an ambiguous (unresolvable)
/// name. References matching more than this many global symbols are dropped
/// entirely (too noisy to be useful).
const MAX_AMBIGUOUS_CANDIDATES: usize = 5;

/// Maps symbol names to their defining NodeIds for cross-file resolution.
#[derive(Debug, Default)]
pub struct SymbolTable {
    /// Fully-qualified name -> NodeId
    pub symbols: HashMap<String, Vec<NodeId>>,
    /// File path -> exported symbols
    pub exports: HashMap<String, Vec<String>>,
    /// File path -> (symbol name -> NodeIds defined in that file).
    /// Used for the same-file and imported-file tiers of the precision ladder.
    pub by_file: HashMap<String, HashMap<String, Vec<NodeId>>>,
    /// Node id (of any CodeBlock or File) -> its containing file path.
    /// Lets `resolve_references` derive the source file from a ref's `from_node`
    /// whether it is a File node (top-level import) or a nested CodeBlock.
    pub node_to_file: HashMap<NodeId, String>,
}

impl SymbolTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build the symbol table from the code graph.
    pub fn build_from_graph(graph: &CodeGraph) -> Self {
        let mut table = Self::new();

        for (id, node) in &graph.nodes {
            match node {
                CodeNode::CodeBlock { name, parent, .. } => {
                    // Get file path for fully-qualified name
                    let file_path = Self::get_file_path(graph, parent);
                    let fqn = format!("{}::{}", file_path, name);
                    table
                        .symbols
                        .entry(name.clone())
                        .or_default()
                        .push(id.clone());
                    table.symbols.entry(fqn).or_default().push(id.clone());

                    // Per-file index for same-file / imported-file resolution.
                    table
                        .by_file
                        .entry(file_path.clone())
                        .or_default()
                        .entry(name.clone())
                        .or_default()
                        .push(id.clone());

                    table.node_to_file.insert(id.clone(), file_path);
                }
                CodeNode::File { path, id: file_id, .. } => {
                    // A ref's from_node can be a File node (top-level imports),
                    // so map file ids to their own path.
                    table.node_to_file.insert(file_id.clone(), path.clone());
                }
                _ => {}
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

    /// Look up the file path a reference's `from_node` belongs to.
    fn file_of(&self, from_node: &NodeId) -> Option<&String> {
        self.node_to_file.get(from_node)
    }

    /// Resolve raw references into edges using a precision ladder.
    ///
    /// Applies name normalization before lookup:
    /// - FunctionCall/MethodCall: strips method receiver (`foo.bar()` -> `bar`)
    ///   and module path (`module::func` -> `func`)
    /// - TypeReference/Inheritance/TraitImpl: strips generic params (`Foo<Bar>` -> `Foo`)
    ///   and path prefix (`std::collections::HashMap` -> `HashMap`)
    ///
    /// Then resolves the normalized name against the source file (derived from
    /// `raw_ref.from_node`) using the following tiers, best match first:
    /// 1. a match in the same file            -> [`Resolution::SameFile`]
    /// 2. a match in a file the source imports -> [`Resolution::Imported`]
    /// 3. exactly one global match             -> [`Resolution::GlobalUnique`]
    /// 4. 2..=5 global matches                 -> one [`Resolution::Ambiguous`] edge each
    /// 5. more than 5 global matches           -> dropped entirely
    ///
    /// `imports` maps a source file path to the set of file paths it imports
    /// (produced by `ImportResolver::resolve`). Self-edges are always skipped.
    pub fn resolve_references(
        &self,
        refs: &[RawReference],
        imports: &ImportMap,
    ) -> Vec<CodeEdge> {
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

            // For type-like references, an exact fully-qualified match in the
            // graph is unambiguous by construction; treat it as a precise edge.
            let is_type_ref = matches!(
                &raw_ref.kind,
                crate::parser::RawRefKind::TypeReference
                    | crate::parser::RawRefKind::Inheritance
                    | crate::parser::RawRefKind::TraitImpl
            );
            if is_type_ref && lookup_name != raw_ref.name {
                if let Some(fqn_targets) = self.symbols.get(&raw_ref.name) {
                    for target in fqn_targets {
                        if *target != raw_ref.from_node {
                            edges.push(CodeEdge {
                                source: raw_ref.from_node.clone(),
                                target: target.clone(),
                                kind: kind.clone(),
                                weight: 1,
                                resolution: Resolution::GlobalUnique,
                            });
                        }
                    }
                    // Resolved via FQN; do not also run the fuzzy ladder.
                    continue;
                }
            }

            self.resolve_via_ladder(raw_ref, &kind, &lookup_name, imports, &mut edges);
        }

        edges
    }

    /// Apply the precision ladder for a single normalized reference, pushing the
    /// resulting edge(s) onto `edges`.
    fn resolve_via_ladder(
        &self,
        raw_ref: &RawReference,
        kind: &EdgeKind,
        lookup_name: &str,
        imports: &ImportMap,
        edges: &mut Vec<CodeEdge>,
    ) {
        let source_file = self.file_of(&raw_ref.from_node).cloned();

        // Tier 1: a match in the same file.
        if let Some(file) = &source_file {
            if let Some(targets) = self
                .by_file
                .get(file)
                .and_then(|names| names.get(lookup_name))
            {
                let mut pushed = false;
                for target in targets {
                    if *target != raw_ref.from_node {
                        edges.push(CodeEdge {
                            source: raw_ref.from_node.clone(),
                            target: target.clone(),
                            kind: kind.clone(),
                            weight: 1,
                            resolution: Resolution::SameFile,
                        });
                        pushed = true;
                    }
                }
                if pushed {
                    return;
                }
            }
        }

        // Tier 2: matches in files the source file imports.
        if let Some(file) = &source_file {
            if let Some(imported_files) = imports.get(file) {
                let mut imported_targets: Vec<NodeId> = Vec::new();
                for imported in imported_files {
                    if let Some(targets) = self
                        .by_file
                        .get(imported)
                        .and_then(|names| names.get(lookup_name))
                    {
                        for target in targets {
                            if *target != raw_ref.from_node {
                                imported_targets.push(target.clone());
                            }
                        }
                    }
                }
                if !imported_targets.is_empty() {
                    for target in imported_targets {
                        edges.push(CodeEdge {
                            source: raw_ref.from_node.clone(),
                            target,
                            kind: kind.clone(),
                            weight: 1,
                            resolution: Resolution::Imported,
                        });
                    }
                    return;
                }
            }
        }

        // Tiers 3-5: global name matches.
        let global = match self.symbols.get(lookup_name) {
            Some(targets) => targets,
            None => return,
        };

        // Distinct, non-self candidates.
        let mut candidates: Vec<NodeId> = Vec::new();
        let mut seen: HashSet<&NodeId> = HashSet::new();
        for target in global {
            if *target != raw_ref.from_node && seen.insert(target) {
                candidates.push(target.clone());
            }
        }

        match candidates.len() {
            0 => {}
            // Tier 3: exactly one global match.
            1 => {
                edges.push(CodeEdge {
                    source: raw_ref.from_node.clone(),
                    target: candidates.into_iter().next().unwrap(),
                    kind: kind.clone(),
                    weight: 1,
                    resolution: Resolution::GlobalUnique,
                });
            }
            // Tier 4: 2..=MAX ambiguous candidates -> flagged edge to each.
            // Tier 5: more than MAX -> drop entirely.
            n if n <= MAX_AMBIGUOUS_CANDIDATES => {
                for target in candidates {
                    edges.push(CodeEdge {
                        source: raw_ref.from_node.clone(),
                        target,
                        kind: kind.clone(),
                        weight: 1,
                        resolution: Resolution::Ambiguous,
                    });
                }
            }
            _ => {}
        }
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

    /// An empty import map for tests that don't exercise the imported-file tier.
    fn no_imports() -> ImportMap {
        ImportMap::new()
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

        let edges = table.resolve_references(&refs, &no_imports());
        assert!(!edges.is_empty(), "expected at least one resolved edge");

        let edge = edges
            .iter()
            .find(|e| e.source == block_a_id && e.target == block_b_id)
            .expect("expected edge from alpha to beta");
        assert_eq!(edge.kind, EdgeKind::FunctionCall);
        // alpha and beta live in the same file -> SameFile resolution.
        assert_eq!(edge.resolution, Resolution::SameFile);
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

        let edges = table.resolve_references(&refs, &no_imports());
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

        // The caller does not import a.py or b.py, so 'foo' has 2 global matches
        // and no closer tier: both edges should be produced and flagged Ambiguous.
        let edges = table.resolve_references(&refs, &no_imports());
        let targets: Vec<_> = edges.iter().map(|e| e.target.clone()).collect();
        assert!(
            targets.contains(&foo1_id),
            "expected edge to foo in a.py"
        );
        assert!(
            targets.contains(&foo2_id),
            "expected edge to foo in b.py"
        );
        assert!(
            edges.iter().all(|e| e.resolution == Resolution::Ambiguous),
            "ambiguous global matches should be flagged Resolution::Ambiguous"
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

    // -- Precision ladder tests --

    /// Add a Python file node with the given code-block function names.
    fn add_py_file(graph: &mut CodeGraph, path: &str, funcs: &[&str]) -> Vec<NodeId> {
        let file_id = NodeId::file(path);
        let mut children = Vec::new();
        let mut ids = Vec::new();
        for (i, name) in funcs.iter().enumerate() {
            let block_id = NodeId::code_block(path, name, i + 1);
            children.push(block_id.clone());
            ids.push(block_id.clone());
            graph.add_node(CodeNode::CodeBlock {
                id: block_id,
                name: (*name).to_string(),
                kind: BlockKind::Function,
                span: make_span(),
                signature: None,
                visibility: None,
                parent: file_id.clone(),
                children: Vec::new(),
            });
        }
        graph.add_node(CodeNode::File {
            id: file_id,
            name: path.to_string(),
            path: path.to_string(),
            language: None,
            children,
        });
        ids
    }

    fn call_ref(from: &NodeId, name: &str) -> RawReference {
        RawReference {
            from_node: from.clone(),
            kind: RawRefKind::FunctionCall,
            name: name.to_string(),
            span: make_span(),
        }
    }

    #[test]
    fn ladder_same_file_wins_over_imported_and_global() {
        // `target` defined in the same file (a.py), in an imported file (b.py),
        // and in an unrelated global file (c.py). Same-file must win.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "a.py", &["caller", "target"]);
        let b_ids = add_py_file(&mut graph, "b.py", &["target"]);
        let _c_ids = add_py_file(&mut graph, "c.py", &["target"]);
        let caller = a_ids[0].clone();
        let same_file_target = a_ids[1].clone();
        let _imported_target = b_ids[0].clone();

        let table = SymbolTable::build_from_graph(&graph);

        // a.py imports b.py.
        let mut imports = ImportMap::new();
        imports
            .entry("a.py".to_string())
            .or_default()
            .insert("b.py".to_string());

        let edges = table.resolve_references(&[call_ref(&caller, "target")], &imports);
        assert_eq!(edges.len(), 1, "same-file match should be the sole edge");
        assert_eq!(edges[0].target, same_file_target);
        assert_eq!(edges[0].resolution, Resolution::SameFile);
    }

    #[test]
    fn ladder_imported_file_wins_over_global() {
        // `target` only in an imported file (b.py) and an unrelated file (c.py).
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "a.py", &["caller"]);
        let b_ids = add_py_file(&mut graph, "b.py", &["target"]);
        let _c_ids = add_py_file(&mut graph, "c.py", &["target"]);
        let caller = a_ids[0].clone();
        let imported_target = b_ids[0].clone();

        let table = SymbolTable::build_from_graph(&graph);

        let mut imports = ImportMap::new();
        imports
            .entry("a.py".to_string())
            .or_default()
            .insert("b.py".to_string());

        let edges = table.resolve_references(&[call_ref(&caller, "target")], &imports);
        assert_eq!(edges.len(), 1, "imported match should be the sole edge");
        assert_eq!(edges[0].target, imported_target);
        assert_eq!(edges[0].resolution, Resolution::Imported);
    }

    #[test]
    fn ladder_single_global_match_is_global_unique() {
        // `target` exists in exactly one file the caller neither shares nor imports.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "a.py", &["caller"]);
        let b_ids = add_py_file(&mut graph, "b.py", &["target"]);
        let caller = a_ids[0].clone();
        let target = b_ids[0].clone();

        let table = SymbolTable::build_from_graph(&graph);

        let edges = table.resolve_references(&[call_ref(&caller, "target")], &ImportMap::new());
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, target);
        assert_eq!(edges[0].resolution, Resolution::GlobalUnique);
    }

    #[test]
    fn ambiguity_cap_three_matches_produces_three_flagged_edges() {
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "a.py", &["caller"]);
        add_py_file(&mut graph, "b.py", &["target"]);
        add_py_file(&mut graph, "c.py", &["target"]);
        add_py_file(&mut graph, "d.py", &["target"]);
        let caller = a_ids[0].clone();

        let table = SymbolTable::build_from_graph(&graph);

        let edges = table.resolve_references(&[call_ref(&caller, "target")], &ImportMap::new());
        assert_eq!(edges.len(), 3, "3 global matches -> 3 ambiguous edges");
        assert!(edges.iter().all(|e| e.resolution == Resolution::Ambiguous));
    }

    #[test]
    fn ambiguity_cap_six_matches_produces_no_edges() {
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "a.py", &["caller"]);
        for f in ["b.py", "c.py", "d.py", "e.py", "f.py", "g.py"] {
            add_py_file(&mut graph, f, &["target"]);
        }
        let caller = a_ids[0].clone();

        let table = SymbolTable::build_from_graph(&graph);

        let edges = table.resolve_references(&[call_ref(&caller, "target")], &ImportMap::new());
        assert!(edges.is_empty(), "6 global matches exceed the cap -> dropped");
    }
}
