use std::collections::HashMap;

use crate::model::{Language, NodeId};

const TS_JS_EXTENSIONS: &[&str] = &["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"];
const PYTHON_EXTENSIONS: &[&str] = &[".py", "/__init__.py"];
const RUST_EXTENSIONS: &[&str] = &[".rs", "/mod.rs"];

/// All extensions combined, used when language is unknown.
const ALL_EXTENSIONS: &[&str] = &[
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    "/index.ts",
    "/index.js",
    ".py",
    "/__init__.py",
    ".rs",
    "/mod.rs",
];

/// Probe a base path with language-appropriate extensions against a path map.
pub fn probe_path(
    base: &str,
    language: Language,
    path_map: &HashMap<String, NodeId>,
) -> Option<NodeId> {
    let extensions = match language {
        Language::TypeScript | Language::JavaScript => TS_JS_EXTENSIONS,
        Language::Python => PYTHON_EXTENSIONS,
        Language::Rust => RUST_EXTENSIONS,
    };

    for ext in extensions {
        let candidate = format!("{}{}", base, ext);
        if let Some(id) = path_map.get(&candidate) {
            return Some(id.clone());
        }
    }
    None
}

/// Probe a base path with all known extensions against a path map.
/// Used when the source language is unknown.
pub fn probe_path_all(base: &str, path_map: &HashMap<String, NodeId>) -> Option<NodeId> {
    for ext in ALL_EXTENSIONS {
        let candidate = format!("{}{}", base, ext);
        if let Some(id) = path_map.get(&candidate) {
            return Some(id.clone());
        }
    }
    None
}
