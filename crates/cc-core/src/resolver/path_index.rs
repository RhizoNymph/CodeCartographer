//! Language-aware index of scanned file paths.
//!
//! Import resolution needs to turn a module path written in source (`./util`,
//! `mypkg.mod`, `crate::util`) into the [`NodeId`] of a scanned file. Two
//! questions come up:
//!
//! * "is there a file at exactly this path?" -- [`PathIndex::exact`]
//! * "which file does this *extension-less* module path name, for source
//!   written in language L?" -- [`PathIndex::resolve`] / [`PathIndex::probe`]
//!
//! The second question has no language-blind answer. `shared/util.py`,
//! `shared/util.ts` and `shared/util.rs` all name the module path
//! `shared/util`; only the importing file's language says which one is meant.
//! The index therefore never exposes an extension-less key -- the only way to
//! ask about one is to say what language is asking. That makes the
//! "language-blind extension-less lookup" that used to mis-resolve polyglot
//! repos unrepresentable rather than merely discouraged.

use std::collections::HashMap;

use crate::model::{CodeGraph, CodeNode, Language, NodeId};

use super::extension_probe::{probe_path, probe_path_all};

/// Every scanned file, keyed by its full repository-relative path.
///
/// Built once per [`crate::resolver::ImportResolver::resolve`] call and shared
/// by every reference in that pass.
pub struct PathIndex {
    /// Full paths only (`shared/util.ts`), never extension-stripped keys.
    by_path: HashMap<String, NodeId>,
    /// The same paths as a list, for consumers that need the raw file set
    /// (Python package-root detection).
    file_paths: Vec<String>,
}

impl PathIndex {
    /// Index every `File` node in `graph`.
    pub fn from_graph(graph: &CodeGraph) -> Self {
        let mut by_path = HashMap::new();
        let mut file_paths = Vec::new();
        for (id, node) in &graph.nodes {
            if let CodeNode::File { path, .. } = node {
                file_paths.push(path.clone());
                by_path.insert(path.clone(), id.clone());
            }
        }
        Self {
            by_path,
            file_paths,
        }
    }

    /// The paths of all indexed files, in unspecified order.
    pub fn file_paths(&self) -> &[String] {
        &self.file_paths
    }

    /// Look up a path verbatim. Only matches a file whose repository-relative
    /// path is exactly `path`, extension included.
    pub fn exact(&self, path: &str) -> Option<NodeId> {
        self.by_path.get(path).cloned()
    }

    /// Extension probing for `language` only (see [`probe_path`]). Never
    /// considers another language's extensions.
    pub fn probe(&self, base: &str, language: Language) -> Option<NodeId> {
        probe_path(base, language, &self.by_path)
    }

    /// Resolve a module path written in `language`.
    ///
    /// Tries `base` verbatim first (an import may name a file exactly, and
    /// extension-less files exist), then language-appropriate extension
    /// probing. When `language` is `None` -- the importing file's language is
    /// unknown -- every known extension is probed in the fixed
    /// [`probe_path_all`] order, which keeps the outcome deterministic.
    ///
    /// A *known* language never falls through to another language's
    /// extensions: an unresolvable import is preferable to an import edge that
    /// crosses a language boundary that cannot exist at runtime.
    pub fn resolve(&self, base: &str, language: Option<&Language>) -> Option<NodeId> {
        if let Some(id) = self.by_path.get(base) {
            return Some(id.clone());
        }
        match language {
            Some(lang) => probe_path(base, lang.clone(), &self.by_path),
            None => probe_path_all(base, &self.by_path),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(paths: &[&str]) -> PathIndex {
        let mut graph = CodeGraph::new(NodeId::directory(""));
        for path in paths {
            graph.add_node(CodeNode::File {
                id: NodeId::file(path),
                name: path.to_string(),
                path: path.to_string(),
                language: None,
                children: Vec::new(),
            });
        }
        PathIndex::from_graph(&graph)
    }

    #[test]
    fn exact_never_matches_an_extension_stripped_key() {
        let idx = index(&["shared/util.ts"]);
        assert_eq!(
            idx.exact("shared/util.ts"),
            Some(NodeId::file("shared/util.ts"))
        );
        assert_eq!(
            idx.exact("shared/util"),
            None,
            "extension-stripped keys must not exist in the index"
        );
    }

    #[test]
    fn resolve_picks_the_file_matching_the_asking_language() {
        let idx = index(&["shared/util.py", "shared/util.ts", "shared/util.rs"]);
        assert_eq!(
            idx.resolve("shared/util", Some(&Language::TypeScript)),
            Some(NodeId::file("shared/util.ts"))
        );
        assert_eq!(
            idx.resolve("shared/util", Some(&Language::Python)),
            Some(NodeId::file("shared/util.py"))
        );
        assert_eq!(
            idx.resolve("shared/util", Some(&Language::Rust)),
            Some(NodeId::file("shared/util.rs"))
        );
    }

    #[test]
    fn resolve_does_not_cross_language_boundaries() {
        let idx = index(&["shared/util.py"]);
        assert_eq!(
            idx.resolve("shared/util", Some(&Language::TypeScript)),
            None
        );
        assert_eq!(idx.resolve("shared/util", Some(&Language::Rust)), None);
    }

    #[test]
    fn resolve_prefers_a_verbatim_path_over_probing() {
        let idx = index(&["shared/util", "shared/util.ts"]);
        assert_eq!(
            idx.resolve("shared/util", Some(&Language::TypeScript)),
            Some(NodeId::file("shared/util"))
        );
    }

    #[test]
    fn resolve_with_unknown_language_probes_all_extensions() {
        let idx = index(&["shared/util.py"]);
        assert_eq!(
            idx.resolve("shared/util", None),
            Some(NodeId::file("shared/util.py"))
        );
    }
}
