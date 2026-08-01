//! Cross-workstream seam: imported-symbol bindings over a polyglot path index.
//!
//! Two independent changes meet here:
//!
//! * `SymbolTable` gained a binding tier that resolves `from x import Thing as T`
//!   by matching the binding's `module_path` against the files the import
//!   resolver already resolved for that source file (`module_path_names_file`).
//! * `PathIndex` replaced the extension-stripped path map, so an extension-less
//!   module path is now probed only against the *importing file's* language.
//!
//! The binding tier trusts whatever the import map contains. If the import map
//! could still name a same-stem file in another language, a Python `from .util
//! import Thing` would bind to a TypeScript `Thing`. These tests pin the two
//! together on exactly that collision; neither change is tested against the
//! other anywhere else.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use cc_core::model::{CodeEdge, CodeGraph, CodeNode, Language, NodeId, Resolution};
use cc_core::parser::Extractor;
use cc_core::repo::RepoScanner;
use cc_core::resolver::{ImportResolver, SymbolTable};

/// A package where `util` exists in three languages with the same symbol name.
const FILES: &[(&str, &str)] = &[
    ("pkg/__init__.py", ""),
    ("pkg/util.py", "class Thing:\n    def label(self):\n        return \"py\"\n"),
    ("pkg/util.ts", "export class Thing {\n  label() { return \"ts\"; }\n}\n"),
    ("pkg/util.rs", "pub struct Thing;\n"),
    (
        "pkg/app.py",
        "from .util import Thing as T\n\n\ndef use():\n    return T()\n",
    ),
    ("pkg/app.ts", "import { Thing } from './util';\n\nexport const x = new Thing();\n"),
];

fn build() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().expect("temp dir");
    let root = tmp.path().join("polyglot_pkg");
    for (rel, contents) in FILES {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(&path, contents).expect("write");
    }
    (tmp, root)
}

fn run(root: &Path) -> (CodeGraph, Vec<CodeEdge>, Vec<CodeEdge>) {
    let mut graph = RepoScanner::scan(root).expect("scan");

    let files: Vec<(NodeId, String, Language)> = graph
        .nodes
        .values()
        .filter_map(|n| match n {
            CodeNode::File { id, path, language: Some(l), .. } => {
                Some((id.clone(), path.clone(), l.clone()))
            }
            _ => None,
        })
        .collect();

    let mut refs = Vec::new();
    for (file_id, path, lang) in &files {
        let source = fs::read_to_string(root.join(path)).expect("read");
        let (nodes, file_refs) = Extractor::extract_file(path, &source, lang).expect("extract");
        for code_node in nodes {
            let is_top =
                matches!(&code_node, CodeNode::CodeBlock { parent, .. } if parent == file_id);
            let cid = code_node.id().clone();
            if is_top {
                if let Some(p) = graph.nodes.get_mut(file_id) {
                    p.children_mut().push(cid);
                }
            }
            graph.add_node(code_node);
        }
        refs.extend(file_refs);
    }

    let table = SymbolTable::build_from_graph(&graph);
    let (import_edges, import_map) = ImportResolver::resolve(&graph, &refs);
    let symbol_edges = table.resolve_references(&refs, &import_map);
    (graph, import_edges, symbol_edges)
}

/// Which file each symbol edge out of `source_file` points into.
fn target_files(edges: &[CodeEdge], source_file: &str) -> BTreeSet<String> {
    edges
        .iter()
        .filter(|e| e.source.0.starts_with(source_file))
        .map(|e| e.target.0.split("::").next().unwrap_or("").to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[test]
fn python_binding_resolves_into_the_python_module_not_a_same_stem_sibling() {
    let (_tmp, root) = build();
    let (_graph, _imports, symbol_edges) = run(&root);

    let targets = target_files(&symbol_edges, "pkg/app.py");

    assert!(
        targets.contains("pkg/util.py"),
        "`from .util import Thing as T` then `T()` must bind into pkg/util.py, got {targets:?}"
    );
    assert!(
        !targets.contains("pkg/util.ts") && !targets.contains("pkg/util.rs"),
        "python binding must never reach a same-stem file in another language, got {targets:?}"
    );
}

#[test]
fn the_alias_binds_to_the_original_symbol_name() {
    let (_tmp, root) = build();
    let (_graph, _imports, symbol_edges) = run(&root);

    // The source says `T()`; the symbol is named `Thing`. The binding tier has
    // to carry the rename back, and do so at the confident tier.
    let bound: Vec<&CodeEdge> = symbol_edges
        .iter()
        .filter(|e| e.source.0.starts_with("pkg/app.py") && e.target.0.contains("pkg/util.py::Thing"))
        .collect();

    assert!(
        !bound.is_empty(),
        "alias `T` must resolve to `Thing`, edges were {:?}",
        symbol_edges
            .iter()
            .map(|e| format!("{} -> {}", e.source.0, e.target.0))
            .collect::<Vec<_>>()
    );
    assert!(
        bound.iter().all(|e| e.resolution == Resolution::Imported),
        "an explicit from-import binding is the confident tier, got {:?}",
        bound.iter().map(|e| &e.resolution).collect::<Vec<_>>()
    );
}

#[test]
fn each_language_import_lands_on_its_own_file() {
    let (_tmp, root) = build();
    let (_graph, import_edges, _symbol_edges) = run(&root);

    let py: BTreeSet<String> = import_edges
        .iter()
        .filter(|e| e.source.0 == "pkg/app.py")
        .map(|e| e.target.0.clone())
        .collect();
    let ts: BTreeSet<String> = import_edges
        .iter()
        .filter(|e| e.source.0 == "pkg/app.ts")
        .map(|e| e.target.0.clone())
        .collect();

    assert!(
        py.contains("pkg/util.py") && !py.contains("pkg/util.ts"),
        "python import must reach pkg/util.py, got {py:?}"
    );
    assert!(
        ts.contains("pkg/util.ts") && !ts.contains("pkg/util.py"),
        "typescript import must reach pkg/util.ts, got {ts:?}"
    );
}
