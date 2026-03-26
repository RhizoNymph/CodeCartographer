use cc_core::model::{Language, NodeId};
use cc_core::resolver::extension_probe::probe_path;
use std::collections::HashMap;

#[test]
fn test_probe_ts_extensions() {
    let mut map = HashMap::new();
    map.insert("src/utils.ts".to_string(), NodeId::file("src/utils.ts"));
    assert!(probe_path("src/utils", Language::TypeScript, &map).is_some());
}

#[test]
fn test_probe_ts_tsx_extension() {
    let mut map = HashMap::new();
    map.insert(
        "src/Component.tsx".to_string(),
        NodeId::file("src/Component.tsx"),
    );
    assert!(probe_path("src/Component", Language::TypeScript, &map).is_some());
}

#[test]
fn test_probe_ts_index() {
    let mut map = HashMap::new();
    map.insert(
        "src/utils/index.ts".to_string(),
        NodeId::file("src/utils/index.ts"),
    );
    assert!(probe_path("src/utils", Language::TypeScript, &map).is_some());
}

#[test]
fn test_probe_js_extensions() {
    let mut map = HashMap::new();
    map.insert("src/utils.js".to_string(), NodeId::file("src/utils.js"));
    assert!(probe_path("src/utils", Language::JavaScript, &map).is_some());
}

#[test]
fn test_probe_python_extensions() {
    let mut map = HashMap::new();
    map.insert("src/utils.py".to_string(), NodeId::file("src/utils.py"));
    assert!(probe_path("src/utils", Language::Python, &map).is_some());
}

#[test]
fn test_probe_python_init() {
    let mut map = HashMap::new();
    map.insert(
        "src/utils/__init__.py".to_string(),
        NodeId::file("src/utils/__init__.py"),
    );
    assert!(probe_path("src/utils", Language::Python, &map).is_some());
}

#[test]
fn test_probe_rust_mod_rs() {
    let mut map = HashMap::new();
    map.insert(
        "src/parser/mod.rs".to_string(),
        NodeId::file("src/parser/mod.rs"),
    );
    assert!(probe_path("src/parser", Language::Rust, &map).is_some());
}

#[test]
fn test_probe_rust_rs_extension() {
    let mut map = HashMap::new();
    map.insert(
        "src/parser.rs".to_string(),
        NodeId::file("src/parser.rs"),
    );
    assert!(probe_path("src/parser", Language::Rust, &map).is_some());
}

#[test]
fn test_probe_no_match() {
    let map = HashMap::new();
    assert!(probe_path("src/nonexistent", Language::TypeScript, &map).is_none());
}

#[test]
fn test_probe_exact_match() {
    let mut map = HashMap::new();
    map.insert("src/utils".to_string(), NodeId::file("src/utils"));
    // TypeScript probes "" (empty ext) first, which means exact match
    assert!(probe_path("src/utils", Language::TypeScript, &map).is_some());
}
