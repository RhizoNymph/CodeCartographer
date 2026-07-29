//! Cross-workstream seam coverage: Python extraction output feeding import resolution.
//!
//! The extractor (`parser/python.rs`) and the import resolver
//! (`resolver/import_resolver.rs` + `resolver/python_roots.rs`) were built
//! independently against an agreed `RawRefKind::Import { module_path }` contract:
//! a clean dotted module path with the `as` alias clause stripped, imported
//! symbol names excluded, and one reference per imported module.
//!
//! Each side is unit-tested against that contract in isolation. These tests pin
//! the two halves *together* on the import forms that exercise both at once --
//! aliased, multi-name, star and bare-package imports resolved against a
//! detected `src` package root. Every case here fails if either half regresses.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use cc_core::model::{CodeGraph, CodeNode, EdgeKind, Language, NodeId, Resolution};
use cc_core::parser::Extractor;
use cc_core::repo::RepoScanner;
use cc_core::resolver::ImportResolver;

/// The seam fixture: a `src`-layout package whose entry module imports its
/// siblings through every form the contract covers.
const FILES: &[(&str, &str)] = &[
    ("src/mypkg/__init__.py", "VERSION = \"1.0\"\n"),
    ("src/mypkg/mod.py", "class Thing:\n    pass\n"),
    ("src/mypkg/other.py", "def other_fn():\n    pass\n"),
    ("src/mypkg/mod.pyi", "class Thing: ...\n"),
    ("src/mypkg/sub/__init__.py", ""),
    ("src/mypkg/sub/helper.py", "def assist():\n    pass\n"),
    (
        "src/mypkg/seam.py",
        // Ordered to cover: future-import (must emit nothing), stdlib multi-name
        // (must resolve to nothing), aliased import, multi-name first-and-second
        // name, star import, and bare package import.
        "from __future__ import annotations\n\
         \n\
         import os, sys\n\
         import mypkg.mod as m\n\
         import mypkg.other, mypkg.sub.helper\n\
         from mypkg.sub.helper import *\n\
         import mypkg\n\
         \n\
         \n\
         def use() -> None:\n\
         \x20   m.Thing()\n",
    ),
];

fn build_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().expect("failed to create temp dir");
    let root = tmp.path().join("seam_fixture");
    for (rel, contents) in FILES {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("file must have a parent"))
            .expect("failed to create fixture dir");
        fs::write(&path, contents).expect("failed to write fixture file");
    }
    (tmp, root)
}

/// Scan, parse every language-bearing file, and resolve imports -- the same
/// pipeline `parse_repo` runs.
fn scan_parse_resolve(root: &Path) -> (CodeGraph, Vec<cc_core::model::CodeEdge>) {
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

    let (edges, _import_map) = ImportResolver::resolve(&graph, &refs);
    (graph, edges)
}

fn targets_from(edges: &[cc_core::model::CodeEdge], source: &str) -> BTreeSet<String> {
    edges
        .iter()
        .filter(|e| e.source.0 == source)
        .map(|e| e.target.0.clone())
        .collect()
}

#[test]
fn alias_multiname_star_and_bare_package_imports_resolve_end_to_end() {
    let (_tmp, root) = build_fixture();
    let (_graph, edges) = scan_parse_resolve(&root);

    let actual = targets_from(&edges, "src/mypkg/seam.py");

    let expected: BTreeSet<String> = [
        // `import mypkg.mod as m` -- alias clause must be stripped by the
        // extractor before the resolver ever sees it.
        "src/mypkg/mod.py",
        // `import mypkg.other, mypkg.sub.helper` -- BOTH names must survive;
        // the extractor previously kept only the first.
        "src/mypkg/other.py",
        // second multi-name entry, also reached by `from ... import *`
        "src/mypkg/sub/helper.py",
        // `import mypkg` -- bare package resolving to its `__init__.py`.
        "src/mypkg/__init__.py",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();

    assert_eq!(
        actual, expected,
        "seam import edge set mismatch for src/mypkg/seam.py"
    );

    assert!(
        edges
            .iter()
            .all(|e| e.kind == EdgeKind::Import && e.resolution == Resolution::Imported),
        "every seam import edge must be an exact Import edge"
    );
}

#[test]
fn future_and_stdlib_imports_produce_no_edges() {
    let (_tmp, root) = build_fixture();
    let (_graph, edges) = scan_parse_resolve(&root);

    // `from __future__ import annotations` emits no Import reference at all,
    // and `import os, sys` names nothing inside the repo.
    for absent in ["__future__", "/os.py", "/sys.py"] {
        assert!(
            !edges.iter().any(|e| e.target.0.contains(absent)),
            "no edge should target {absent}, got {:?}",
            edges.iter().map(|e| &e.target.0).collect::<Vec<_>>()
        );
    }
}

#[test]
fn stub_never_shadows_the_real_module_through_an_aliased_import() {
    let (_tmp, root) = build_fixture();
    let (_graph, edges) = scan_parse_resolve(&root);

    // `import mypkg.mod as m` must land on mod.py even though mod.pyi exists.
    assert!(
        !edges
            .iter()
            .any(|e| e.target == NodeId::file("src/mypkg/mod.pyi")),
        "`.pyi` stub must not win over `mod.py`"
    );
}

#[test]
fn seam_resolution_is_deterministic_across_runs() {
    // Package-root ordering and the extension-stripped path map are both built
    // from HashMaps; repeat the whole pipeline to catch iteration-order leaks.
    let (_tmp, root) = build_fixture();

    let first = {
        let (_g, edges) = scan_parse_resolve(&root);
        targets_from(&edges, "src/mypkg/seam.py")
    };

    for run in 1..16 {
        let (_g, edges) = scan_parse_resolve(&root);
        let actual = targets_from(&edges, "src/mypkg/seam.py");
        assert_eq!(actual, first, "resolution differed on run {run}");
    }
}
