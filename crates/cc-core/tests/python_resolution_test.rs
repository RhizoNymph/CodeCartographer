//! End-to-end coverage for Python repository scanning and import resolution.
//!
//! Scans the on-disk fixture at `tests/fixtures/python_src_layout` (copied into
//! a temp dir so no ambient `.gitignore` can influence the walk), parses every
//! Python file, and resolves the resulting imports. The fixture is a `src`
//! layout, which is the case the resolver historically could not handle.

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::Path;

use cc_core::model::{CodeGraph, CodeNode, EdgeKind, Language, NodeId, Resolution};
use cc_core::parser::Extractor;
use cc_core::repo::RepoScanner;
use cc_core::resolver::ImportResolver;

/// Recursively copy `src` into `dst`, creating `dst` if needed.
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn fixture_root() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/python_src_layout")
}

/// Copy the fixture into a temp dir and scan it.
fn scan_fixture() -> (tempfile::TempDir, CodeGraph) {
    let tmp = tempfile::tempdir().expect("failed to create temp dir");
    let root = tmp.path().join("python_src_layout");
    copy_dir(&fixture_root(), &root).expect("failed to copy fixture");

    let graph = RepoScanner::scan(&root).expect("scan should succeed");
    (tmp, graph)
}

fn file_paths(graph: &CodeGraph) -> BTreeSet<String> {
    graph
        .nodes
        .values()
        .filter_map(|n| match n {
            CodeNode::File { path, .. } => Some(path.clone()),
            _ => None,
        })
        .collect()
}

/// Parse every language-bearing file in the graph, adding its blocks to the
/// graph and returning all raw references.
fn parse_all(root: &Path, graph: &mut CodeGraph) -> Vec<cc_core::parser::RawReference> {
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
    refs
}

#[test]
fn scanner_skips_python_junk_directories() {
    let (_tmp, graph) = scan_fixture();
    let paths = file_paths(&graph);

    for junk in [
        "venv/lib/python3.11/site-packages/vendored/__init__.py",
        "venv/lib/python3.11/site-packages/vendored/heavy.py",
        "src/mypkg/__pycache__/stale.py",
        "build/junk.py",
        "src/mypkg.egg-info/PKG-INFO",
    ] {
        assert!(
            !paths.contains(junk),
            "{junk} should have been skipped, scanned files: {paths:?}"
        );
    }

    // No directory node for the skipped trees either.
    for junk_dir in [
        "venv",
        "build",
        "src/mypkg/__pycache__",
        "src/mypkg.egg-info",
    ] {
        assert!(
            !graph.nodes.contains_key(&NodeId::directory(junk_dir)),
            "{junk_dir} should not have a directory node"
        );
    }
}

#[test]
fn scanner_keeps_python_package_named_build() {
    let (_tmp, graph) = scan_fixture();
    let paths = file_paths(&graph);

    assert!(
        paths.contains("src/mypkg/build/real.py"),
        "a real package named `build` must survive the scan, got {paths:?}"
    );
    assert!(paths.contains("src/mypkg/build/__init__.py"));
}

#[test]
fn scanner_recognizes_pyi_stubs_as_python() {
    let (_tmp, graph) = scan_fixture();

    let stub = graph
        .nodes
        .get(&NodeId::file("src/mypkg/mod.pyi"))
        .expect("stub file node should exist");
    match stub {
        CodeNode::File { language, .. } => {
            assert_eq!(
                *language,
                Some(Language::Python),
                "`.pyi` must map to Python"
            )
        }
        other => panic!("expected a File node, got {other:?}"),
    }
}

#[test]
fn scanner_finds_exactly_the_real_source_files() {
    let (_tmp, graph) = scan_fixture();
    let paths = file_paths(&graph);

    let expected: BTreeSet<String> = [
        "src/mypkg/__init__.py",
        "src/mypkg/app.py",
        "src/mypkg/build/__init__.py",
        "src/mypkg/build/real.py",
        "src/mypkg/mod.py",
        "src/mypkg/mod.pyi",
        "src/mypkg/sub/__init__.py",
        "src/mypkg/sub/helper.py",
        "tests/test_app.py",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();

    assert_eq!(paths, expected);
}

#[test]
fn src_layout_imports_resolve_end_to_end() {
    let tmp = tempfile::tempdir().expect("failed to create temp dir");
    let root = tmp.path().join("python_src_layout");
    copy_dir(&fixture_root(), &root).expect("failed to copy fixture");
    let mut graph = RepoScanner::scan(&root).expect("scan should succeed");

    let refs = parse_all(&root, &mut graph);
    let (edges, import_map) = ImportResolver::resolve(&graph, &refs);

    let actual: BTreeSet<(String, String)> = edges
        .iter()
        .map(|e| (e.source.0.clone(), e.target.0.clone()))
        .collect();

    let expected: BTreeSet<(String, String)> = [
        // src-layout absolute import from inside the package.
        ("src/mypkg/app.py", "src/mypkg/mod.py"),
        ("src/mypkg/app.py", "src/mypkg/sub/helper.py"),
        ("src/mypkg/app.py", "src/mypkg/build/real.py"),
        // `from . import package_name`
        ("src/mypkg/app.py", "src/mypkg/__init__.py"),
        // `from ..mod import Thing`
        ("src/mypkg/sub/helper.py", "src/mypkg/mod.py"),
        // src-layout absolute import from a sibling `tests/` tree.
        ("tests/test_app.py", "src/mypkg/app.py"),
        ("tests/test_app.py", "src/mypkg/sub/helper.py"),
    ]
    .into_iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect();

    assert_eq!(actual, expected, "resolved import edge set mismatch");

    assert!(
        edges
            .iter()
            .all(|e| e.kind == EdgeKind::Import && e.resolution == Resolution::Imported),
        "every import edge must be an exact Import edge"
    );

    // The stub must never win over the real module.
    assert!(
        !edges
            .iter()
            .any(|e| e.target == NodeId::file("src/mypkg/mod.pyi")),
        "`.pyi` stub must not shadow `mod.py`"
    );

    // Stdlib imports (`import os`) resolve to nothing.
    let app_imports: &HashSet<String> = import_map
        .get("src/mypkg/app.py")
        .expect("app.py should have imports");
    assert!(!app_imports.iter().any(|p| p.contains("os")));
}
