//! Cross-language import resolution correctness.
//!
//! In a polyglot repo `shared/util.py`, `shared/util.ts` and `shared/util.rs`
//! all name the same extension-less module path `shared/util`. Resolution must
//! pick the file whose language matches the **importing** file, not whichever
//! candidate happened to win a language-blind lookup.
//!
//! These tests drive `ImportResolver::resolve` over in-memory graphs (no
//! filesystem) so the polyglot fixture is exact and order-independent.

use std::collections::BTreeSet;

use cc_core::model::{CodeEdge, CodeGraph, CodeNode, EdgeKind, Language, NodeId, Resolution};
use cc_core::parser::{RawRefKind, RawReference};
use cc_core::resolver::ImportResolver;

fn span() -> cc_core::model::Span {
    cc_core::model::Span {
        start_line: 1,
        start_col: 0,
        end_line: 1,
        end_col: 0,
    }
}

/// Add a `File` node with an explicit language (`None` = language unknown).
fn file(graph: &mut CodeGraph, path: &str, language: Option<Language>) {
    graph.add_node(CodeNode::File {
        id: NodeId::file(path),
        name: path.to_string(),
        path: path.to_string(),
        language,
        children: Vec::new(),
    });
}

fn py(graph: &mut CodeGraph, path: &str) {
    file(graph, path, Some(Language::Python));
}

fn ts(graph: &mut CodeGraph, path: &str) {
    file(graph, path, Some(Language::TypeScript));
}

fn js(graph: &mut CodeGraph, path: &str) {
    file(graph, path, Some(Language::JavaScript));
}

fn rs(graph: &mut CodeGraph, path: &str) {
    file(graph, path, Some(Language::Rust));
}

fn import_ref(from_file: &str, module_path: &str) -> RawReference {
    RawReference {
        from_node: NodeId::file(from_file),
        kind: RawRefKind::Import {
            module_path: module_path.to_string(),
        },
        name: module_path.to_string(),
        span: span(),
    }
}

/// The single import edge produced for `refs`, or a panic with context.
fn single_target(graph: &CodeGraph, refs: &[RawReference]) -> NodeId {
    let (edges, _map) = ImportResolver::resolve(graph, refs);
    assert_eq!(
        edges.len(),
        1,
        "expected exactly one import edge, got {:?}",
        edges
            .iter()
            .map(|e: &CodeEdge| (e.source.0.clone(), e.target.0.clone()))
            .collect::<Vec<_>>()
    );
    assert_eq!(edges[0].kind, EdgeKind::Import);
    assert_eq!(edges[0].resolution, Resolution::Imported);
    edges[0].target.clone()
}

/// A polyglot module: the stem `util` exists as `.py`, `.ts` and `.rs` in the
/// same directory, plus one importing file per language.
///
/// Everything lives under `src/` because Rust `crate::` paths resolve against
/// the crate's `src` root; the Python and TypeScript files are unaffected by
/// the directory name.
fn polyglot_graph() -> CodeGraph {
    let mut graph = CodeGraph::new(NodeId::directory(""));
    py(&mut graph, "src/util.py");
    ts(&mut graph, "src/util.ts");
    rs(&mut graph, "src/util.rs");
    py(&mut graph, "src/app.py");
    ts(&mut graph, "src/app.ts");
    rs(&mut graph, "src/main.rs");
    graph
}

// --- Each language reaches its own file -----------------------------------

#[test]
fn typescript_relative_import_reaches_the_typescript_file() {
    let graph = polyglot_graph();
    let refs = vec![import_ref("src/app.ts", "./util")];
    assert_eq!(
        single_target(&graph, &refs),
        NodeId::file("src/util.ts"),
        "a TypeScript import must not land on util.py / util.rs"
    );
}

#[test]
fn python_relative_import_reaches_the_python_file() {
    let graph = polyglot_graph();
    let refs = vec![import_ref("src/app.py", ".util")];
    assert_eq!(
        single_target(&graph, &refs),
        NodeId::file("src/util.py"),
        "a Python relative import must not land on util.ts / util.rs"
    );
}

#[test]
fn python_absolute_import_reaches_the_python_file() {
    let graph = polyglot_graph();
    let refs = vec![import_ref("src/app.py", "util")];
    assert_eq!(
        single_target(&graph, &refs),
        NodeId::file("src/util.py"),
        "a Python absolute import must not land on util.ts / util.rs"
    );
}

#[test]
fn rust_use_path_reaches_the_rust_file() {
    // A Rust crate laid out under `src/`, colliding with same-stem Python and
    // TypeScript files in the same directory.
    let mut graph = CodeGraph::new(NodeId::directory(""));
    rs(&mut graph, "src/main.rs");
    rs(&mut graph, "src/util.rs");
    py(&mut graph, "src/util.py");
    ts(&mut graph, "src/util.ts");

    let refs = vec![import_ref("src/main.rs", "crate::util::Helper")];
    assert_eq!(
        single_target(&graph, &refs),
        NodeId::file("src/util.rs"),
        "a Rust use path must not land on util.py / util.ts"
    );
}

#[test]
fn javascript_relative_import_reaches_the_javascript_file() {
    let mut graph = CodeGraph::new(NodeId::directory(""));
    js(&mut graph, "shared/app.js");
    js(&mut graph, "shared/util.js");
    py(&mut graph, "shared/util.py");

    let refs = vec![import_ref("shared/app.js", "./util")];
    assert_eq!(
        single_target(&graph, &refs),
        NodeId::file("shared/util.js"),
        "a JavaScript import must not land on util.py"
    );
}

#[test]
fn typescript_import_ignores_a_python_only_module() {
    // Language correctness cuts both ways: with no TS/JS candidate the import
    // resolves to nothing rather than crossing into Python.
    let mut graph = CodeGraph::new(NodeId::directory(""));
    ts(&mut graph, "shared/app.ts");
    py(&mut graph, "shared/util.py");

    let refs = vec![import_ref("shared/app.ts", "./util")];
    let (edges, map) = ImportResolver::resolve(&graph, &refs);
    assert!(
        edges.is_empty(),
        "a TypeScript import must not resolve to a Python file, got {:?}",
        edges.iter().map(|e| e.target.0.clone()).collect::<Vec<_>>()
    );
    assert!(map.is_empty());
}

#[test]
fn every_language_resolves_its_own_file_in_one_pass() {
    // All three imports resolved together, so a shared path index cannot be
    // "correct" merely by being rebuilt per reference.
    let graph = polyglot_graph();
    let refs = vec![
        import_ref("src/app.ts", "./util"),
        import_ref("src/app.py", ".util"),
        import_ref("src/main.rs", "crate::util"),
    ];
    let (edges, _map) = ImportResolver::resolve(&graph, &refs);

    let actual: BTreeSet<(String, String)> = edges
        .iter()
        .map(|e| (e.source.0.clone(), e.target.0.clone()))
        .collect();
    let expected: BTreeSet<(String, String)> = [
        ("src/app.ts", "src/util.ts"),
        ("src/app.py", "src/util.py"),
        ("src/main.rs", "src/util.rs"),
    ]
    .into_iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect();

    assert_eq!(actual, expected);
}

// --- `.pyi` stubs still never shadow the real module ----------------------

#[test]
fn pyi_stub_never_shadows_the_module_even_in_a_polyglot_repo() {
    let mut graph = CodeGraph::new(NodeId::directory(""));
    py(&mut graph, "shared/app.py");
    py(&mut graph, "shared/util.py");
    py(&mut graph, "shared/util.pyi");
    ts(&mut graph, "shared/util.ts");

    let refs = vec![import_ref("shared/app.py", ".util")];
    assert_eq!(single_target(&graph, &refs), NodeId::file("shared/util.py"));
}

#[test]
fn stub_only_module_still_resolves_next_to_a_same_stem_typescript_file() {
    let mut graph = CodeGraph::new(NodeId::directory(""));
    py(&mut graph, "shared/app.py");
    py(&mut graph, "shared/util.pyi");
    ts(&mut graph, "shared/util.ts");

    let refs = vec![import_ref("shared/app.py", ".util")];
    assert_eq!(
        single_target(&graph, &refs),
        NodeId::file("shared/util.pyi"),
        "a stub-only module must still resolve, and never to the .ts file"
    );
}

// --- Unknown importing language stays deterministic ------------------------

#[test]
fn unknown_importing_language_resolves_deterministically() {
    // A file whose extension maps to no known language still resolves through
    // the all-extension probe order, which is a fixed constant -- so repeated
    // runs over the same (HashMap-backed) graph must agree.
    let mut seen: Option<NodeId> = None;
    for run in 0..16 {
        let mut graph = CodeGraph::new(NodeId::directory(""));
        file(&mut graph, "shared/app.unknown", None);
        py(&mut graph, "shared/util.py");
        ts(&mut graph, "shared/util.ts");
        rs(&mut graph, "shared/util.rs");

        let refs = vec![import_ref("shared/app.unknown", "./util")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);
        assert_eq!(edges.len(), 1, "expected one edge on run {run}");
        match &seen {
            None => seen = Some(edges[0].target.clone()),
            Some(first) => assert_eq!(
                &edges[0].target, first,
                "unknown-language import resolved differently on run {run}"
            ),
        }
    }
    assert_eq!(
        seen,
        Some(NodeId::file("shared/util.ts")),
        "the all-extension probe order puts .ts ahead of .py and .rs"
    );
}

// --- Single-language repos are unaffected ---------------------------------

#[test]
fn single_language_python_repo_is_unaffected() {
    let mut graph = CodeGraph::new(NodeId::directory(""));
    py(&mut graph, "src/mypkg/__init__.py");
    py(&mut graph, "src/mypkg/app.py");
    py(&mut graph, "src/mypkg/mod.py");
    py(&mut graph, "src/mypkg/sub/__init__.py");
    py(&mut graph, "src/mypkg/sub/helper.py");

    let refs = vec![
        import_ref("src/mypkg/app.py", "mypkg.mod"),
        import_ref("src/mypkg/app.py", ".sub.helper"),
        import_ref("src/mypkg/app.py", "."),
    ];
    let (edges, _map) = ImportResolver::resolve(&graph, &refs);

    let actual: BTreeSet<String> = edges.iter().map(|e| e.target.0.clone()).collect();
    let expected: BTreeSet<String> = [
        "src/mypkg/mod.py",
        "src/mypkg/sub/helper.py",
        "src/mypkg/__init__.py",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    assert_eq!(actual, expected);
}

#[test]
fn single_language_typescript_repo_is_unaffected() {
    let mut graph = CodeGraph::new(NodeId::directory(""));
    ts(&mut graph, "src/app.ts");
    ts(&mut graph, "src/util.ts");
    ts(&mut graph, "src/widgets/index.ts");
    ts(&mut graph, "src/Component.tsx");
    js(&mut graph, "src/legacy.js");

    let refs = vec![
        import_ref("src/app.ts", "./util"),
        import_ref("src/app.ts", "./widgets"),
        import_ref("src/app.ts", "./Component"),
        import_ref("src/app.ts", "./legacy"),
    ];
    let (edges, _map) = ImportResolver::resolve(&graph, &refs);

    let actual: BTreeSet<String> = edges.iter().map(|e| e.target.0.clone()).collect();
    let expected: BTreeSet<String> = [
        "src/util.ts",
        "src/widgets/index.ts",
        "src/Component.tsx",
        "src/legacy.js",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    assert_eq!(actual, expected);
}

#[test]
fn extensionless_file_still_resolves_by_exact_path() {
    // The path index keeps full paths verbatim, so a file with no extension at
    // all is still reachable by an exact import path.
    let mut graph = CodeGraph::new(NodeId::directory(""));
    ts(&mut graph, "src/app.ts");
    file(&mut graph, "src/vendored", Some(Language::TypeScript));

    let refs = vec![import_ref("src/app.ts", "./vendored")];
    assert_eq!(single_target(&graph, &refs), NodeId::file("src/vendored"));
}
