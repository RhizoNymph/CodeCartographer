use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::model::{CodeEdge, CodeGraph, CodeNode, EdgeKind, Language, NodeId, Resolution};
use crate::parser::{RawRefKind, RawReference};

use super::extension_probe::{probe_path, probe_path_all};

/// Map of `source file path -> set of file paths it imports`.
///
/// Produced by [`ImportResolver::resolve`] and consumed by the symbol resolver
/// to give references an "imported file" precision tier (see the resolution
/// precision ladder in `symbol_table.rs`).
pub type ImportMap = HashMap<String, HashSet<String>>;

/// Resolves import statements to their target files/modules.
pub struct ImportResolver;

impl ImportResolver {
    /// Resolve import references into file-to-file [`CodeEdge`]s and an
    /// [`ImportMap`] describing which files each source file imports.
    ///
    /// Import edges are exact (the resolver only emits an edge when it finds a
    /// concrete target file), so they carry [`Resolution::Imported`].
    pub fn resolve(graph: &CodeGraph, refs: &[RawReference]) -> (Vec<CodeEdge>, ImportMap) {
        let mut edges = Vec::new();
        let mut import_map: ImportMap = HashMap::new();

        // Build a map of file paths to NodeIds for fast lookup
        let mut path_to_id: HashMap<String, NodeId> = HashMap::new();
        for (id, node) in &graph.nodes {
            if let CodeNode::File { path, .. } = node {
                // Store with and without extension
                path_to_id.insert(path.clone(), id.clone());

                // Also store without extension for import resolution
                if let Some(stem) = Path::new(path).file_stem() {
                    let parent = Path::new(path).parent().unwrap_or(Path::new(""));
                    let without_ext = parent.join(stem).to_string_lossy().to_string();
                    path_to_id.insert(without_ext, id.clone());
                }
            }
        }

        for raw_ref in refs {
            if let RawRefKind::Import { module_path } = &raw_ref.kind {
                // Try to resolve the import path
                let from_file = Self::get_file_of_node(graph, &raw_ref.from_node);
                let from_language = Self::get_file_language(graph, &from_file);

                if let Some(target_id) = Self::resolve_import_path(
                    module_path,
                    &from_file,
                    from_language.as_ref(),
                    &path_to_id,
                ) {
                    // Import edge from file to file
                    let source_file_id = NodeId::file(&from_file);
                    if source_file_id != target_id {
                        // Record the import relationship keyed by file path so the
                        // symbol resolver can look up "does source import target".
                        if let Some(CodeNode::File { path, .. }) = graph.nodes.get(&target_id) {
                            import_map
                                .entry(from_file.clone())
                                .or_default()
                                .insert(path.clone());
                        }
                        edges.push(CodeEdge {
                            source: source_file_id,
                            target: target_id,
                            kind: EdgeKind::Import,
                            weight: 1,
                            resolution: Resolution::Imported,
                        });
                    }
                }
            }
        }

        // Deduplicate edges
        edges.sort_by(|a, b| (&a.source.0, &a.target.0).cmp(&(&b.source.0, &b.target.0)));
        edges.dedup_by(|a, b| a.source == b.source && a.target == b.target);

        (edges, import_map)
    }

    fn get_file_of_node(graph: &CodeGraph, node_id: &NodeId) -> String {
        match graph.nodes.get(node_id) {
            Some(CodeNode::File { path, .. }) => path.clone(),
            Some(CodeNode::CodeBlock { parent, .. }) => Self::get_file_of_node(graph, parent),
            _ => node_id.0.clone(),
        }
    }

    /// Get the language of a file node by path.
    fn get_file_language(graph: &CodeGraph, file_path: &str) -> Option<Language> {
        let file_id = NodeId::file(file_path);
        if let Some(CodeNode::File { language, .. }) = graph.nodes.get(&file_id) {
            language.clone()
        } else {
            None
        }
    }

    fn resolve_import_path(
        module_path: &str,
        from_file: &str,
        language: Option<&Language>,
        path_map: &HashMap<String, NodeId>,
    ) -> Option<NodeId> {
        // Handle Python-style leading-dot relative imports (`.foo`, `..pkg.mod`,
        // or a bare `.` / `..` for `from . import x`). These are distinguished
        // from TS/JS `./foo` and `../bar` by the absence of a slash right after
        // the leading dots. Must be checked BEFORE the generic `starts_with('.')`
        // branch below (which only understands `./`-style paths).
        if matches!(language, Some(Language::Python)) && module_path.starts_with('.') {
            if let Some(id) =
                Self::resolve_python_relative(module_path, from_file, path_map)
            {
                return Some(id);
            }
            // Fall through to the generic handling below if the Python-specific
            // resolution failed to find a target.
        }

        // Handle relative imports (./foo, ../bar)
        if module_path.starts_with('.') {
            let from_dir = Path::new(from_file).parent().unwrap_or(Path::new(""));

            let resolved = from_dir.join(module_path);
            let normalized = Self::normalize_path(&resolved);

            // Try exact match first
            if let Some(id) = path_map.get(&normalized) {
                return Some(id.clone());
            }

            // Use extension probing based on language
            if let Some(lang) = language {
                return probe_path(&normalized, lang.clone(), path_map);
            }
            return probe_path_all(&normalized, path_map);
        }

        // Handle Python dotted imports (foo.bar.baz -> foo/bar/baz.py)
        if module_path.contains('.') && !module_path.contains('/') {
            let as_path = module_path.replace('.', "/");
            if let Some(id) = path_map.get(&as_path) {
                return Some(id.clone());
            }
            return probe_path(&as_path, Language::Python, path_map);
        }

        // Handle Rust use paths (crate::foo::Bar, super::sibling, self::sub).
        if module_path.contains("::") {
            return Self::resolve_rust_use_path(module_path, from_file, path_map);
        }

        // Bare module name lookup
        if let Some(id) = path_map.get(module_path) {
            return Some(id.clone());
        }

        None
    }

    /// Resolve a Rust use path (`crate::a::b::Item`, `super::sibling::Item`,
    /// `self::sub::Item`) to a file in the repo.
    ///
    /// Rust paths name modules and items, not files, so resolution probes
    /// progressively shorter prefixes: `crate::model::graph::CodeGraph` first
    /// tries `<src>/model/graph/CodeGraph` (`.rs`, `/mod.rs`), then
    /// `<src>/model/graph.rs` (the file defining `CodeGraph`), then
    /// `<src>/model.rs` / `<src>/model/mod.rs`. Paths rooted in external crates
    /// (`std::...`, dependency crates) do not resolve to repo files.
    fn resolve_rust_use_path(
        module_path: &str,
        from_file: &str,
        path_map: &HashMap<String, NodeId>,
    ) -> Option<NodeId> {
        let mut segments: Vec<&str> = module_path.split("::").collect();
        if segments.is_empty() {
            return None;
        }

        // Determine the base directory the remaining segments resolve against.
        let base: PathBuf = match segments[0] {
            "crate" => {
                segments.remove(0);
                Self::crate_src_root(from_file)
            }
            "self" => {
                segments.remove(0);
                Self::module_dir(from_file)
            }
            "super" => {
                let mut dir = Self::module_dir(from_file);
                while segments.first() == Some(&"super") {
                    segments.remove(0);
                    dir = dir.parent().map(Path::to_path_buf).unwrap_or_default();
                }
                dir
            }
            // External crate (std, serde, workspace sibling) -- not resolvable
            // to a file within this repo scan.
            _ => return None,
        };

        let base_str = base.to_string_lossy().to_string();
        let join_base = |suffix: &str| {
            if base_str.is_empty() {
                suffix.to_string()
            } else {
                format!("{}/{}", base_str, suffix)
            }
        };

        // Probe progressively shorter prefixes: the path may name an item
        // (function/type) inside a module file rather than the file itself.
        for take in (1..=segments.len()).rev() {
            let candidate = join_base(&segments[..take].join("/"));
            if let Some(id) = probe_path(&candidate, Language::Rust, path_map) {
                return Some(id);
            }
        }

        // All segments consumed (e.g. `use crate::Item;` or bare `super::Item`
        // fully probed): the target is the crate root file or the base module.
        for root in ["lib", "main"] {
            if let Some(id) = probe_path(&join_base(root), Language::Rust, path_map) {
                return Some(id);
            }
        }
        probe_path(&base_str, Language::Rust, path_map)
    }

    /// The directory a Rust file's module owns: `src/model/mod.rs` (and
    /// `lib.rs`/`main.rs`) own their containing directory, while a file module
    /// like `src/model/graph.rs` owns the virtual directory `src/model/graph`
    /// (so `super::` from it means `src/model`).
    fn module_dir(from_file: &str) -> PathBuf {
        let path = Path::new(from_file);
        let parent = path.parent().unwrap_or(Path::new("")).to_path_buf();
        match path.file_stem().and_then(|s| s.to_str()) {
            Some("mod") | Some("lib") | Some("main") => parent,
            Some(stem) => parent.join(stem),
            None => parent,
        }
    }

    /// The crate `src` root for a file: everything up to and including the last
    /// `src` path component (`crates/cc-core/src/model/graph.rs` ->
    /// `crates/cc-core/src`), supporting multi-crate workspaces. Falls back to
    /// `src` when the file is not under a `src` directory.
    fn crate_src_root(from_file: &str) -> PathBuf {
        let path = Path::new(from_file);
        let components: Vec<&std::ffi::OsStr> = path.iter().collect();
        match components.iter().rposition(|c| *c == "src") {
            Some(idx) => components[..=idx].iter().collect(),
            None => PathBuf::from("src"),
        }
    }

    /// Resolve a Python leading-dot relative import.
    ///
    /// Counts the leading dots: 1 dot means the source file's own package
    /// directory, and each additional dot walks one parent directory up. The
    /// remainder after the dots (a dotted module path) is converted to a
    /// filesystem path and resolved against that base directory, probing both
    /// `<path>.py` and `<path>/__init__.py`. A bare `.`/`..` (as in
    /// `from . import x`) resolves to the base directory's `__init__.py`.
    fn resolve_python_relative(
        module_path: &str,
        from_file: &str,
        path_map: &HashMap<String, NodeId>,
    ) -> Option<NodeId> {
        let dot_count = module_path.chars().take_while(|&c| c == '.').count();
        if dot_count == 0 {
            return None;
        }
        let remainder = &module_path[dot_count..];

        // Start from the source file's directory (the package for 1 dot), then
        // walk up one directory for each dot beyond the first.
        let mut base = Path::new(from_file)
            .parent()
            .unwrap_or(Path::new(""))
            .to_path_buf();
        for _ in 1..dot_count {
            base = base.parent().unwrap_or(Path::new("")).to_path_buf();
        }

        let base_str = base.to_string_lossy().to_string();

        if remainder.is_empty() {
            // `from . import x` -> the package's __init__.py.
            let init = if base_str.is_empty() {
                "__init__.py".to_string()
            } else {
                format!("{}/__init__.py", base_str)
            };
            return path_map.get(&init).cloned();
        }

        // Convert the dotted remainder to a path segment and join onto the base.
        let sub = remainder.replace('.', "/");
        let joined = if base_str.is_empty() {
            sub
        } else {
            format!("{}/{}", base_str, sub)
        };
        let normalized = Self::normalize_path(Path::new(&joined));

        // Exact match, then probe module file / package __init__.py.
        if let Some(id) = path_map.get(&normalized) {
            return Some(id.clone());
        }
        probe_path(&normalized, Language::Python, path_map)
    }

    fn normalize_path(path: &Path) -> String {
        let mut parts: Vec<&str> = Vec::new();
        for component in path.components() {
            match component {
                std::path::Component::Normal(s) => {
                    parts.push(s.to_str().unwrap_or(""));
                }
                std::path::Component::ParentDir => {
                    parts.pop();
                }
                std::path::Component::CurDir => {}
                _ => {}
            }
        }
        parts.join("/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CodeGraph, CodeNode, EdgeKind, Language, NodeId, Span};
    use crate::parser::{RawRefKind, RawReference};

    fn make_span() -> Span {
        Span {
            start_line: 1,
            start_col: 0,
            end_line: 1,
            end_col: 0,
        }
    }

    fn py_file(graph: &mut CodeGraph, path: &str) {
        graph.add_node(CodeNode::File {
            id: NodeId::file(path),
            name: path.to_string(),
            path: path.to_string(),
            language: Some(Language::Python),
            children: Vec::new(),
        });
    }

    /// Build an import ref originating from `from_file`.
    fn import_ref(from_file: &str, module_path: &str) -> RawReference {
        RawReference {
            from_node: NodeId::file(from_file),
            kind: RawRefKind::Import {
                module_path: module_path.to_string(),
            },
            name: module_path.to_string(),
            span: make_span(),
        }
    }

    #[test]
    fn python_sibling_relative_import_resolves() {
        // pkg/a.py imports `.sibling` -> pkg/sibling.py
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "pkg/a.py");
        py_file(&mut graph, "pkg/sibling.py");

        let refs = vec![import_ref("pkg/a.py", ".sibling")];
        let (edges, map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1, "expected one import edge");
        assert_eq!(edges[0].target, NodeId::file("pkg/sibling.py"));
        assert_eq!(edges[0].kind, EdgeKind::Import);
        assert_eq!(edges[0].resolution, Resolution::Imported);
        assert!(map["pkg/a.py"].contains("pkg/sibling.py"));
    }

    #[test]
    fn python_parent_relative_import_resolves() {
        // pkg/sub/a.py imports `..parent_mod` -> pkg/parent_mod.py (one dir up).
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "pkg/sub/a.py");
        py_file(&mut graph, "pkg/parent_mod.py");

        let refs = vec![import_ref("pkg/sub/a.py", "..parent_mod")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("pkg/parent_mod.py"));
    }

    #[test]
    fn python_parent_dotted_relative_import_resolves() {
        // pkg/sub/a.py imports `..other.mod` -> pkg/other/mod.py.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "pkg/sub/a.py");
        py_file(&mut graph, "pkg/other/mod.py");

        let refs = vec![import_ref("pkg/sub/a.py", "..other.mod")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("pkg/other/mod.py"));
    }

    #[test]
    fn python_from_dot_import_resolves_to_package_init() {
        // pkg/a.py does `from . import x`; module path is `.` -> pkg/__init__.py.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "pkg/a.py");
        py_file(&mut graph, "pkg/__init__.py");

        let refs = vec![import_ref("pkg/a.py", ".")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("pkg/__init__.py"));
    }

    #[test]
    fn python_relative_import_of_package_resolves_to_init() {
        // pkg/a.py imports `.subpkg` where subpkg is a package -> pkg/subpkg/__init__.py
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "pkg/a.py");
        py_file(&mut graph, "pkg/subpkg/__init__.py");

        let refs = vec![import_ref("pkg/a.py", ".subpkg")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("pkg/subpkg/__init__.py"));
    }

    fn rs_file(graph: &mut CodeGraph, path: &str) {
        graph.add_node(CodeNode::File {
            id: NodeId::file(path),
            name: path.to_string(),
            path: path.to_string(),
            language: Some(Language::Rust),
            children: Vec::new(),
        });
    }

    #[test]
    fn rust_crate_import_resolves_in_workspace_crate() {
        // crates/core/src/lib.rs uses crate::model::graph::CodeGraph; the path
        // names an item, so resolution must drop the trailing segment and land
        // on the defining file. The crate root is derived from the source file
        // (workspace layout), not assumed to be `src/`.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        rs_file(&mut graph, "crates/core/src/lib.rs");
        rs_file(&mut graph, "crates/core/src/model/graph.rs");

        let refs = vec![import_ref(
            "crates/core/src/lib.rs",
            "crate::model::graph::CodeGraph",
        )];
        let (edges, map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("crates/core/src/model/graph.rs"));
        assert!(map["crates/core/src/lib.rs"].contains("crates/core/src/model/graph.rs"));
    }

    #[test]
    fn rust_crate_import_resolves_to_mod_rs() {
        // crate::model with model as a mod.rs directory module.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        rs_file(&mut graph, "src/main.rs");
        rs_file(&mut graph, "src/model/mod.rs");

        let refs = vec![import_ref("src/main.rs", "crate::model::CodeGraph")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("src/model/mod.rs"));
    }

    #[test]
    fn rust_super_import_from_file_module_resolves_to_sibling() {
        // src/model/graph.rs (module model::graph) uses super::edge::CodeEdge
        // -> src/model/edge.rs.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        rs_file(&mut graph, "src/model/graph.rs");
        rs_file(&mut graph, "src/model/edge.rs");

        let refs = vec![import_ref("src/model/graph.rs", "super::edge::CodeEdge")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("src/model/edge.rs"));
    }

    #[test]
    fn rust_crate_root_item_import_resolves_to_lib_rs() {
        // `use crate::Item;` where Item lives in lib.rs.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        rs_file(&mut graph, "src/lib.rs");
        rs_file(&mut graph, "src/util.rs");

        let refs = vec![import_ref("src/util.rs", "crate::Item")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("src/lib.rs"));
    }

    #[test]
    fn rust_external_crate_import_does_not_resolve() {
        // std / dependency crates cannot map to repo files.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        rs_file(&mut graph, "src/lib.rs");

        let refs = vec![import_ref("src/lib.rs", "std::collections::HashMap")];
        let (edges, map) = ImportResolver::resolve(&graph, &refs);

        assert!(edges.is_empty());
        assert!(map.is_empty());
    }
}
