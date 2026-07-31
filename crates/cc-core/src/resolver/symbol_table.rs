use std::collections::{HashMap, HashSet};

use crate::model::{CodeEdge, CodeGraph, CodeNode, EdgeKind, NodeId, Resolution};
use crate::parser::RawReference;

use super::import_resolver::ImportMap;

/// Maximum number of candidate edges emitted for an ambiguous (unresolvable)
/// name. References matching more than this many global symbols are dropped
/// entirely (too noisy to be useful).
const MAX_AMBIGUOUS_CANDIDATES: usize = 5;

/// What a `from <module> import <original> as <local>` statement binds: inside
/// the importing file, `local` denotes the symbol `original` defined in
/// `module_path`.
#[derive(Debug, Clone)]
struct ImportedBinding {
    module_path: String,
    original: String,
}

/// Importing file path -> local name -> binding.
type SymbolBindings = HashMap<String, HashMap<String, ImportedBinding>>;

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
                CodeNode::File {
                    path, id: file_id, ..
                } => {
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
    /// 1. a match in the same file -> [`Resolution::SameFile`]
    /// 2. the symbol named by an explicit `from <module> import <name>` binding
    ///    in the source file, looked up in that module's own file
    ///    -> [`Resolution::Imported`]
    /// 3. a match in any file the source imports -> [`Resolution::Imported`]
    /// 4. exactly one global match -> [`Resolution::GlobalUnique`]
    /// 5. 2..=5 global matches -> one [`Resolution::Ambiguous`] edge each
    /// 6. more than 5 global matches -> dropped entirely
    ///
    /// Tier 2 comes from [`crate::parser::RawRefKind::ImportedSymbol`] refs,
    /// which produce no edges of their own. Besides pinning the exact defining
    /// module, a binding also carries the *original* name through an `as`
    /// rename, so `from m import Thing as T` makes a later `T()` resolve to
    /// `Thing`; that rename applies to tiers 3-6 as well when tier 2 misses.
    ///
    /// `imports` maps a source file path to the set of file paths it imports
    /// (produced by `ImportResolver::resolve`). Self-edges are always skipped.
    pub fn resolve_references(&self, refs: &[RawReference], imports: &ImportMap) -> Vec<CodeEdge> {
        let mut edges = Vec::new();
        let bindings = self.collect_symbol_bindings(refs);

        for raw_ref in refs {
            let (kind, lookup_name) = match &raw_ref.kind {
                crate::parser::RawRefKind::Import { .. } => {
                    (EdgeKind::Import, raw_ref.name.clone())
                }
                // Resolution context only -- deliberately edge-free. See the
                // variant's documentation in `parser/extract.rs`.
                crate::parser::RawRefKind::ImportedSymbol { .. } => continue,
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

            // An Import ref's name is a module path, not a local binding, so it
            // never consults the binding map.
            let binding = if matches!(&raw_ref.kind, crate::parser::RawRefKind::Import { .. }) {
                None
            } else {
                self.file_of(&raw_ref.from_node)
                    .and_then(|file| bindings.get(file))
                    .and_then(|by_local| by_local.get(&lookup_name))
            };

            self.resolve_via_ladder(raw_ref, &kind, &lookup_name, binding, imports, &mut edges);
        }

        edges
    }

    /// Index every [`crate::parser::RawRefKind::ImportedSymbol`] ref by the file
    /// that declared it. A file-local import (inside a function body) still
    /// binds the name file-wide here; that is a deliberate over-approximation,
    /// since the binding only ever *narrows* an otherwise fuzzier match.
    ///
    /// If a file binds the same local name twice (re-import, or a conditional
    /// `try: from a import X / except: from b import X`), the first binding
    /// wins and the ambiguity falls through to the later tiers.
    fn collect_symbol_bindings(&self, refs: &[RawReference]) -> SymbolBindings {
        let mut bindings: SymbolBindings = HashMap::new();
        for raw_ref in refs {
            let crate::parser::RawRefKind::ImportedSymbol {
                module_path,
                original,
                local,
            } = &raw_ref.kind
            else {
                continue;
            };
            let Some(file) = self.file_of(&raw_ref.from_node) else {
                continue;
            };
            bindings
                .entry(file.clone())
                .or_default()
                .entry(local.clone())
                .or_insert_with(|| ImportedBinding {
                    module_path: module_path.clone(),
                    original: original.clone(),
                });
        }
        bindings
    }

    /// Apply the precision ladder for a single normalized reference, pushing the
    /// resulting edge(s) onto `edges`.
    fn resolve_via_ladder(
        &self,
        raw_ref: &RawReference,
        kind: &EdgeKind,
        lookup_name: &str,
        binding: Option<&ImportedBinding>,
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

        // Tier 2: an explicit `from <module> import <name>` binding pins both
        // the defining module and (through an `as` rename) the original name.
        if let (Some(file), Some(binding)) = (&source_file, binding) {
            if let Some(imported_files) = imports.get(file) {
                let mut bound_targets: Vec<NodeId> = Vec::new();
                for imported in imported_files {
                    if !module_path_names_file(&binding.module_path, imported) {
                        continue;
                    }
                    if let Some(targets) = self
                        .by_file
                        .get(imported)
                        .and_then(|names| names.get(&binding.original))
                    {
                        for target in targets {
                            if *target != raw_ref.from_node {
                                bound_targets.push(target.clone());
                            }
                        }
                    }
                }
                if !bound_targets.is_empty() {
                    for target in bound_targets {
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

        // The binding's original name carries through the remaining tiers, so
        // an aliased import still finds the symbol it renamed.
        let lookup_name = binding.map_or(lookup_name, |b| b.original.as_str());

        // Tier 3: matches in files the source file imports.
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

        // Tiers 4-6: global name matches.
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
            // Tier 4: exactly one global match.
            1 => {
                edges.push(CodeEdge {
                    source: raw_ref.from_node.clone(),
                    target: candidates.into_iter().next().unwrap(),
                    kind: kind.clone(),
                    weight: 1,
                    resolution: Resolution::GlobalUnique,
                });
            }
            // Tier 5: 2..=MAX ambiguous candidates -> flagged edge to each.
            // Tier 6: more than MAX -> drop entirely.
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

/// True when `file_path` is plausibly the module named by `module_path`.
///
/// This is only ever applied to files the import resolver already decided the
/// source file imports, so it does not have to resolve anything: it just picks
/// the right entry out of that small set. Leading dots are stripped because a
/// relative import's suffix is what identifies the module either way
/// (`.rel` -> `.../rel.py`, `..pkg.sub` -> `.../pkg/sub.py`).
///
/// A module path that is only dots (`from . import x`) names a package rather
/// than a module and never matches; such references fall through to the
/// general imported-file tier.
fn module_path_names_file(module_path: &str, file_path: &str) -> bool {
    let rel = module_path.trim_start_matches('.');
    if rel.is_empty() {
        return false;
    }
    let suffix = rel.replace('.', "/");

    let stem = match file_path.rfind('.') {
        // Only strip a real extension, never a dot inside a directory name.
        Some(idx) if !file_path[idx..].contains('/') => &file_path[..idx],
        _ => file_path,
    };

    path_ends_with_module(stem, &suffix)
        || path_ends_with_module(stem, &format!("{suffix}/__init__"))
}

fn path_ends_with_module(stem: &str, suffix: &str) -> bool {
    stem == suffix
        || (stem.len() > suffix.len()
            && stem.ends_with(suffix)
            && stem.as_bytes()[stem.len() - suffix.len() - 1] == b'/')
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
        assert!(targets.contains(&foo1_id), "expected edge to foo in a.py");
        assert!(targets.contains(&foo2_id), "expected edge to foo in b.py");
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

    // -- C1: imported-symbol binding tier --

    fn binding_ref(from: &NodeId, module_path: &str, original: &str, local: &str) -> RawReference {
        RawReference {
            from_node: from.clone(),
            kind: RawRefKind::ImportedSymbol {
                module_path: module_path.to_string(),
                original: original.to_string(),
                local: local.to_string(),
            },
            name: local.to_string(),
            span: make_span(),
        }
    }

    fn imports_of(pairs: &[(&str, &str)]) -> ImportMap {
        let mut imports = ImportMap::new();
        for (from, to) in pairs {
            imports
                .entry((*from).to_string())
                .or_default()
                .insert((*to).to_string());
        }
        imports
    }

    #[test]
    fn imported_symbol_bindings_alone_produce_no_edges() {
        // The binding variant is resolution context, not a reference: it must
        // never contribute an edge of its own.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        add_py_file(&mut graph, "a.py", &["caller"]);
        add_py_file(&mut graph, "b.py", &["Thing"]);
        let table = SymbolTable::build_from_graph(&graph);

        let file_a = NodeId::file("a.py");
        let refs = vec![binding_ref(&file_a, "b", "Thing", "T")];

        let edges = table.resolve_references(&refs, &imports_of(&[("a.py", "b.py")]));
        assert!(
            edges.is_empty(),
            "ImportedSymbol refs must not produce edges, got {edges:?}"
        );
    }

    #[test]
    fn aliased_import_resolves_a_use_of_the_alias_to_the_original_symbol() {
        // `from b import Thing as T` in a.py, then `T()` inside `caller`.
        // Without the binding, `T` matches nothing at all.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "a.py", &["caller"]);
        let b_ids = add_py_file(&mut graph, "b.py", &["Thing"]);
        let caller = a_ids[0].clone();
        let thing = b_ids[0].clone();
        let table = SymbolTable::build_from_graph(&graph);

        let refs = vec![
            binding_ref(&NodeId::file("a.py"), "b", "Thing", "T"),
            call_ref(&caller, "T"),
        ];

        let edges = table.resolve_references(&refs, &imports_of(&[("a.py", "b.py")]));
        assert_eq!(edges.len(), 1, "expected exactly one edge, got {edges:?}");
        assert_eq!(edges[0].target, thing);
        assert_eq!(edges[0].source, caller);
        assert_eq!(edges[0].kind, EdgeKind::FunctionCall);
        assert_eq!(edges[0].resolution, Resolution::Imported);
    }

    #[test]
    fn binding_edge_count_matches_the_unbound_baseline() {
        // Adding binding refs must not inflate edge volume: the same use site
        // yields exactly one edge with or without them.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "a.py", &["caller"]);
        add_py_file(&mut graph, "b.py", &["Thing"]);
        let caller = a_ids[0].clone();
        let table = SymbolTable::build_from_graph(&graph);
        let imports = imports_of(&[("a.py", "b.py")]);

        let baseline = table.resolve_references(&[call_ref(&caller, "Thing")], &imports);
        let with_binding = table.resolve_references(
            &[
                binding_ref(&NodeId::file("a.py"), "b", "Thing", "Thing"),
                call_ref(&caller, "Thing"),
            ],
            &imports,
        );
        assert_eq!(baseline.len(), 1);
        assert_eq!(
            with_binding.len(),
            baseline.len(),
            "binding refs must not add edges"
        );
        assert_eq!(with_binding[0].target, baseline[0].target);
    }

    #[test]
    fn binding_narrows_to_the_named_module_among_several_imports() {
        // a.py imports both b.py and c.py, and both define `Thing`. The binding
        // says the name came from b, so only that edge should survive.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "a.py", &["caller"]);
        let b_ids = add_py_file(&mut graph, "pkg/b.py", &["Thing"]);
        add_py_file(&mut graph, "pkg/c.py", &["Thing"]);
        let caller = a_ids[0].clone();
        let b_thing = b_ids[0].clone();
        let table = SymbolTable::build_from_graph(&graph);
        let imports = imports_of(&[("a.py", "pkg/b.py"), ("a.py", "pkg/c.py")]);

        let unbound = table.resolve_references(&[call_ref(&caller, "Thing")], &imports);
        assert_eq!(unbound.len(), 2, "without a binding both imports match");

        let bound = table.resolve_references(
            &[
                binding_ref(&NodeId::file("a.py"), "pkg.b", "Thing", "Thing"),
                call_ref(&caller, "Thing"),
            ],
            &imports,
        );
        assert_eq!(bound.len(), 1, "the binding pins one module, got {bound:?}");
        assert_eq!(bound[0].target, b_thing);
        assert_eq!(bound[0].resolution, Resolution::Imported);
    }

    #[test]
    fn binding_matches_a_relative_module_path() {
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "pkg/sub/a.py", &["caller"]);
        let b_ids = add_py_file(&mut graph, "pkg/mod.py", &["Thing"]);
        let caller = a_ids[0].clone();
        let thing = b_ids[0].clone();
        let table = SymbolTable::build_from_graph(&graph);

        let edges = table.resolve_references(
            &[
                binding_ref(&NodeId::file("pkg/sub/a.py"), "..mod", "Thing", "T"),
                call_ref(&caller, "T"),
            ],
            &imports_of(&[("pkg/sub/a.py", "pkg/mod.py")]),
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, thing);
        assert_eq!(edges[0].resolution, Resolution::Imported);
    }

    #[test]
    fn binding_matches_a_package_resolved_to_its_init() {
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "a.py", &["caller"]);
        let init_ids = add_py_file(&mut graph, "src/pkg/__init__.py", &["Thing"]);
        let caller = a_ids[0].clone();
        let thing = init_ids[0].clone();
        let table = SymbolTable::build_from_graph(&graph);

        let edges = table.resolve_references(
            &[
                binding_ref(&NodeId::file("a.py"), "pkg", "Thing", "T"),
                call_ref(&caller, "T"),
            ],
            &imports_of(&[("a.py", "src/pkg/__init__.py")]),
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, thing);
    }

    #[test]
    fn same_file_definition_still_wins_over_a_binding() {
        // Python's own rule: a local definition shadows the imported name.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "a.py", &["caller", "Thing"]);
        add_py_file(&mut graph, "b.py", &["Thing"]);
        let caller = a_ids[0].clone();
        let local_thing = a_ids[1].clone();
        let table = SymbolTable::build_from_graph(&graph);

        let edges = table.resolve_references(
            &[
                binding_ref(&NodeId::file("a.py"), "b", "Thing", "Thing"),
                call_ref(&caller, "Thing"),
            ],
            &imports_of(&[("a.py", "b.py")]),
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, local_thing);
        assert_eq!(edges[0].resolution, Resolution::SameFile);
    }

    #[test]
    fn alias_falls_back_to_the_original_name_when_the_module_is_unresolved() {
        // The module never resolved to a file (third-party, or an unscanned
        // path), so tier 2 misses -- but the rename must still carry through
        // to the global tier.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        let a_ids = add_py_file(&mut graph, "a.py", &["caller"]);
        let b_ids = add_py_file(&mut graph, "b.py", &["Thing"]);
        let caller = a_ids[0].clone();
        let thing = b_ids[0].clone();
        let table = SymbolTable::build_from_graph(&graph);

        let edges = table.resolve_references(
            &[
                binding_ref(&NodeId::file("a.py"), "vendor.pkg", "Thing", "T"),
                call_ref(&caller, "T"),
            ],
            &ImportMap::new(),
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, thing);
        assert_eq!(edges[0].resolution, Resolution::GlobalUnique);
    }

    #[test]
    fn bindings_are_scoped_to_the_importing_file() {
        // c.py never imported anything; a.py's binding must not leak into it.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        add_py_file(&mut graph, "a.py", &["caller"]);
        add_py_file(&mut graph, "b.py", &["Thing"]);
        let c_ids = add_py_file(&mut graph, "c.py", &["other"]);
        let other = c_ids[0].clone();
        let table = SymbolTable::build_from_graph(&graph);

        let edges = table.resolve_references(
            &[
                binding_ref(&NodeId::file("a.py"), "b", "Thing", "T"),
                call_ref(&other, "T"),
            ],
            &imports_of(&[("a.py", "b.py")]),
        );
        assert!(
            edges.is_empty(),
            "a binding in a.py must not rename `T` inside c.py, got {edges:?}"
        );
    }

    #[test]
    fn module_path_matching_is_anchored_at_a_path_boundary() {
        assert!(module_path_names_file("pkg.mod", "src/pkg/mod.py"));
        assert!(module_path_names_file("pkg.mod", "pkg/mod.py"));
        assert!(module_path_names_file(".mod", "src/pkg/mod.py"));
        assert!(module_path_names_file("pkg", "src/pkg/__init__.py"));
        // `mypkg/mod.py` must not be matched by the module `ypkg.mod`.
        assert!(!module_path_names_file("ypkg.mod", "src/mypkg/mod.py"));
        // A different module with the same tail segment.
        assert!(!module_path_names_file("pkg.mod", "src/other/mod.py"));
        // Dots-only relative imports name a package, not a module.
        assert!(!module_path_names_file(".", "src/pkg/__init__.py"));
        // A dot in a directory name is not an extension.
        assert!(module_path_names_file("pkg.mod", "my.dir/pkg/mod.py"));
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
        assert!(
            edges.is_empty(),
            "6 global matches exceed the cap -> dropped"
        );
    }
}
