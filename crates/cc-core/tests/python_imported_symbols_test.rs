//! End-to-end coverage for Python imported-symbol bindings.
//!
//! `from <module> import <name> as <alias>` emits an edge-free
//! `RawRefKind::ImportedSymbol` binding alongside the usual `Import` ref. These
//! tests drive the real pipeline (scan -> extract -> `ImportResolver::resolve`
//! -> `SymbolTable::resolve_references`) to prove that:
//!
//! - a use of the *alias* resolves to the symbol it renamed, at
//!   [`Resolution::Imported`];
//! - the bindings themselves add no edges, so symbol-edge volume is unchanged.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use cc_core::model::{CodeEdge, CodeGraph, CodeNode, EdgeKind, Language, NodeId, Resolution};
use cc_core::parser::Extractor;
use cc_core::repo::RepoScanner;
use cc_core::resolver::{ImportResolver, SymbolTable};

const FILES: &[(&str, &str)] = &[
    ("src/mypkg/__init__.py", ""),
    ("src/mypkg/mod.py", "class Thing:\n    pass\n"),
    // A same-named symbol in a second imported module: without the binding both
    // would match, so this pins that the binding narrows to the right module.
    ("src/mypkg/decoy.py", "class Thing:\n    pass\n"),
    (
        "src/mypkg/app.py",
        "from mypkg.mod import Thing as T\n\
         from mypkg import decoy\n\
         \n\
         \n\
         def build():\n\
         \x20   return T()\n",
    ),
];

fn build_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().expect("failed to create temp dir");
    let root = tmp.path().join("binding_fixture");
    for (rel, contents) in FILES {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("file must have a parent"))
            .expect("failed to create fixture dir");
        fs::write(&path, contents).expect("failed to write fixture file");
    }
    (tmp, root)
}

/// The full `parse_repo` pipeline, returning the resolved symbol edges.
fn scan_parse_resolve(root: &Path) -> (CodeGraph, Vec<CodeEdge>) {
    let mut graph = RepoScanner::scan(root).expect("scan should succeed");

    let files: Vec<(NodeId, String, Language)> = graph
        .nodes
        .values()
        .filter_map(|node| match node {
            CodeNode::File {
                id,
                path,
                language: Some(lang),
                ..
            } => Some((id.clone(), path.clone(), lang.clone())),
            _ => None,
        })
        .collect();

    let mut refs = Vec::new();
    for (file_id, path, lang) in files {
        let source = fs::read_to_string(root.join(&path)).expect("failed to read fixture source");
        let (nodes, file_refs) =
            Extractor::extract_file(&path, &source, &lang).expect("extraction should succeed");
        for code_node in nodes {
            let is_top_level = matches!(
                &code_node,
                CodeNode::CodeBlock { parent, .. } if *parent == file_id
            );
            let child_id = code_node.id().clone();
            if is_top_level {
                if let Some(parent) = graph.nodes.get_mut(&file_id) {
                    parent.children_mut().push(child_id);
                }
            }
            graph.add_node(code_node);
        }
        refs.extend(file_refs);
    }

    let (_import_edges, import_map) = ImportResolver::resolve(&graph, &refs);
    let table = SymbolTable::build_from_graph(&graph);
    let edges = table.resolve_references(&refs, &import_map);
    (graph, edges)
}

fn block_id(graph: &CodeGraph, file: &str, name: &str) -> NodeId {
    graph
        .nodes
        .values()
        .find_map(|n| match n {
            CodeNode::CodeBlock {
                id, name: n_name, ..
            } if n_name == name && id.0.starts_with(file) => Some(id.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no block named {name} in {file}"))
}

#[test]
fn use_of_an_import_alias_resolves_to_the_original_symbol() {
    let (_tmp, root) = build_fixture();
    let (graph, edges) = scan_parse_resolve(&root);

    let build = block_id(&graph, "src/mypkg/app.py", "build");
    let thing = block_id(&graph, "src/mypkg/mod.py", "Thing");

    let from_build: Vec<&CodeEdge> = edges.iter().filter(|e| e.source == build).collect();
    assert_eq!(
        from_build.len(),
        1,
        "`T()` should resolve to exactly one target, got {:?}",
        from_build
            .iter()
            .map(|e| (&e.target.0, &e.resolution))
            .collect::<Vec<_>>()
    );
    assert_eq!(from_build[0].target, thing);
    assert_eq!(from_build[0].kind, EdgeKind::FunctionCall);
    assert_eq!(
        from_build[0].resolution,
        Resolution::Imported,
        "an explicit import binding is a high-confidence resolution"
    );
}

#[test]
fn bindings_never_target_the_decoy_module() {
    let (_tmp, root) = build_fixture();
    let (graph, edges) = scan_parse_resolve(&root);

    let decoy_thing = block_id(&graph, "src/mypkg/decoy.py", "Thing");
    assert!(
        !edges.iter().any(|e| e.target == decoy_thing),
        "the binding names mypkg.mod, so decoy.Thing must never be a target"
    );
}

#[test]
fn binding_refs_contribute_no_edges_of_their_own() {
    let (_tmp, root) = build_fixture();
    let (_graph, edges) = scan_parse_resolve(&root);

    // Only the single `T()` call site produces a symbol edge; the two
    // `from ... import ...` bindings produce none.
    let sources: BTreeSet<String> = edges.iter().map(|e| e.source.0.clone()).collect();
    assert!(
        !sources.contains("src/mypkg/app.py"),
        "the file node itself (where bindings are attributed) must emit no \
         symbol edges, got sources {sources:?}"
    );
    assert_eq!(edges.len(), 1, "expected one symbol edge, got {edges:?}");
}
