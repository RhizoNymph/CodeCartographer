use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::model::{CodeEdge, CodeGraph, CodeNode, EdgeKind, Language, NodeId, Resolution};
use crate::parser::{RawRefKind, RawReference};

use super::extension_probe::{probe_path, probe_path_all};
use super::python_roots::PythonPackageRoots;

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
        let mut file_paths: Vec<String> = Vec::new();
        for (id, node) in &graph.nodes {
            if let CodeNode::File { path, .. } = node {
                file_paths.push(path.clone());

                // Store with and without extension
                path_to_id.insert(path.clone(), id.clone());

                // Also store without extension for import resolution. Several
                // files can strip to the same key (`mod.py` vs `mod.pyi`), so
                // the winner is chosen by rank rather than by (unordered)
                // iteration order.
                if let Some(stem) = Path::new(path).file_stem() {
                    let parent = Path::new(path).parent().unwrap_or(Path::new(""));
                    let without_ext = parent.join(stem).to_string_lossy().to_string();
                    match path_to_id.entry(without_ext) {
                        Entry::Vacant(slot) => {
                            slot.insert(id.clone());
                        }
                        Entry::Occupied(mut slot) => {
                            let replace = {
                                let incumbent = slot.get().0.as_str();
                                (stripped_key_rank(path), path.as_str())
                                    > (stripped_key_rank(incumbent), incumbent)
                            };
                            if replace {
                                slot.insert(id.clone());
                            }
                        }
                    }
                }
            }
        }

        // Candidate roots for Python absolute imports, derived from the scanned
        // file set (repo root, `src/` dirs, package-chain parents).
        let package_roots = PythonPackageRoots::from_file_paths(&file_paths);

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
                    &package_roots,
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
        package_roots: &PythonPackageRoots,
    ) -> Option<NodeId> {
        // Handle Python-style leading-dot relative imports (`.foo`, `..pkg.mod`,
        // or a bare `.` / `..` for `from . import x`). These are distinguished
        // from TS/JS `./foo` and `../bar` by the absence of a slash right after
        // the leading dots. Must be checked BEFORE the generic `starts_with('.')`
        // branch below (which only understands `./`-style paths).
        if matches!(language, Some(Language::Python)) && module_path.starts_with('.') {
            if let Some(id) = Self::resolve_python_relative(module_path, from_file, path_map) {
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

        // Python absolute imports (`pkg.sub.mod`, `pkg`, `module`) are resolved
        // against every candidate package root, nearest the importing file
        // first, so `src/` layouts and monorepo `packages/*/` layouts work.
        if matches!(language, Some(Language::Python)) {
            return Self::resolve_python_absolute(module_path, from_file, path_map, package_roots);
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

    /// Resolve a Python absolute import (`pkg.sub.mod`, `pkg`, `module`).
    ///
    /// The dotted path is converted to a relative path and probed against each
    /// candidate root from [`PythonPackageRoots`] in nearest-first order, so
    /// `src/mypkg/app.py` importing `mypkg.mod` finds `src/mypkg/mod.py`, and
    /// `tests/test_app.py` importing the same module finds it too. A bare
    /// package name (`import mypkg`) resolves to that package's `__init__.py`
    /// via extension probing. Imports of installed/stdlib modules find no
    /// candidate and yield no edge.
    fn resolve_python_absolute(
        module_path: &str,
        from_file: &str,
        path_map: &HashMap<String, NodeId>,
        package_roots: &PythonPackageRoots,
    ) -> Option<NodeId> {
        if module_path.is_empty() {
            return None;
        }
        let relative = module_path.replace('.', "/");

        for root in package_roots.ordered_for(from_file) {
            let candidate = if root.is_empty() {
                relative.clone()
            } else {
                format!("{}/{}", root, relative)
            };

            // Exact match first (the path map also holds extension-stripped
            // keys), then language-specific probing (`.py`, `/__init__.py`,
            // then the `.pyi` stub forms).
            if let Some(id) = path_map.get(&candidate) {
                return Some(id.clone());
            }
            if let Some(id) = probe_path(&candidate, Language::Python, path_map) {
                return Some(id);
            }
        }

        None
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

/// Rank of a file path competing for an extension-stripped path-map key.
///
/// Several files can strip to the same key (`pkg/mod.py` and `pkg/mod.pyi` both
/// strip to `pkg/mod`). A `.pyi` stub only carries signatures, so the real
/// module must always win; higher rank wins.
///
/// Rank alone does not settle every collision: in a polyglot repo `foo.py` and
/// `foo.ts` also strip to `foo` and rank equally. The caller therefore breaks
/// ties on the full path, which is arbitrary but *stable* -- without it the
/// winner would depend on `HashMap` iteration order and resolution could differ
/// between runs of the same scan. Picking the language-correct file in that case
/// is a separate concern (the stripped key is consulted before language-aware
/// extension probing); see `probe_path`.
fn stripped_key_rank(path: &str) -> u8 {
    if path.ends_with(".pyi") {
        0
    } else {
        1
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

    // --- Python absolute imports -------------------------------------------

    #[test]
    fn python_src_layout_absolute_import_resolves() {
        // src/mypkg/app.py does `import mypkg.mod` -> src/mypkg/mod.py.
        // `src` is a package root even though it has no __init__.py.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "src/mypkg/__init__.py");
        py_file(&mut graph, "src/mypkg/app.py");
        py_file(&mut graph, "src/mypkg/mod.py");

        let refs = vec![import_ref("src/mypkg/app.py", "mypkg.mod")];
        let (edges, map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1, "src-layout absolute import must resolve");
        assert_eq!(edges[0].target, NodeId::file("src/mypkg/mod.py"));
        assert!(map["src/mypkg/app.py"].contains("src/mypkg/mod.py"));
    }

    #[test]
    fn python_src_layout_import_from_tests_dir_resolves() {
        // tests/test_app.py sits outside the source root but still imports the
        // package by its absolute name.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "src/mypkg/__init__.py");
        py_file(&mut graph, "src/mypkg/mod.py");
        py_file(&mut graph, "tests/test_app.py");

        let refs = vec![import_ref("tests/test_app.py", "mypkg.mod")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("src/mypkg/mod.py"));
    }

    #[test]
    fn python_src_layout_deep_dotted_import_resolves() {
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "src/mypkg/__init__.py");
        py_file(&mut graph, "src/mypkg/app.py");
        py_file(&mut graph, "src/mypkg/sub/__init__.py");
        py_file(&mut graph, "src/mypkg/sub/helper.py");

        let refs = vec![import_ref("src/mypkg/app.py", "mypkg.sub.helper")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("src/mypkg/sub/helper.py"));
    }

    #[test]
    fn python_flat_layout_absolute_import_still_resolves() {
        // Regression guard: the pre-existing flat layout must keep working.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "flatpkg/__init__.py");
        py_file(&mut graph, "flatpkg/util.py");
        py_file(&mut graph, "app.py");

        let refs = vec![import_ref("app.py", "flatpkg.util")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("flatpkg/util.py"));
    }

    #[test]
    fn python_bare_package_import_resolves_to_init() {
        // `import flatpkg` where flatpkg/__init__.py exists.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "flatpkg/__init__.py");
        py_file(&mut graph, "app.py");

        let refs = vec![import_ref("app.py", "flatpkg")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(
            edges.len(),
            1,
            "bare package import must resolve to __init__"
        );
        assert_eq!(edges[0].target, NodeId::file("flatpkg/__init__.py"));
    }

    #[test]
    fn python_bare_module_import_at_root_still_resolves() {
        // Regression guard: `import config` -> config.py at the repo root.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "config.py");
        py_file(&mut graph, "app.py");

        let refs = vec![import_ref("app.py", "config")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("config.py"));
    }

    #[test]
    fn python_monorepo_package_import_resolves_against_its_own_root() {
        // packages/svc/svc/... and packages/web/web/... are separate roots.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "packages/svc/svc/__init__.py");
        py_file(&mut graph, "packages/svc/svc/core.py");
        py_file(&mut graph, "packages/web/web/__init__.py");
        py_file(&mut graph, "packages/web/web/app.py");

        let refs = vec![import_ref("packages/web/web/app.py", "svc.core")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("packages/svc/svc/core.py"));
    }

    #[test]
    fn python_stub_only_module_resolves_to_pyi() {
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "src/mypkg/__init__.py");
        py_file(&mut graph, "src/mypkg/app.py");
        py_file(&mut graph, "src/mypkg/typed.pyi");

        let refs = vec![import_ref("src/mypkg/app.py", "mypkg.typed")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("src/mypkg/typed.pyi"));
    }

    #[test]
    fn python_real_module_wins_over_its_stub() {
        // Both mod.py and mod.pyi exist; the real module must always win, and
        // the outcome must not depend on node iteration order.
        for _ in 0..16 {
            let mut graph = CodeGraph::new(NodeId::directory(""));
            py_file(&mut graph, "src/mypkg/__init__.py");
            py_file(&mut graph, "src/mypkg/app.py");
            py_file(&mut graph, "src/mypkg/mod.py");
            py_file(&mut graph, "src/mypkg/mod.pyi");

            let refs = vec![import_ref("src/mypkg/app.py", "mypkg.mod")];
            let (edges, _map) = ImportResolver::resolve(&graph, &refs);

            assert_eq!(edges.len(), 1);
            assert_eq!(edges[0].target, NodeId::file("src/mypkg/mod.py"));
        }
    }

    #[test]
    fn polyglot_stripped_key_collision_resolves_deterministically() {
        // `shared/util.py` and `shared/util.ts` both strip to `shared/util` and
        // rank equally, so the path-map winner used to depend on `HashMap`
        // iteration order -- the same scan could resolve `./util` differently
        // between runs. The tie is now broken on the full path, so whatever the
        // outcome is, it must be the same every time.
        let mut seen: Option<NodeId> = None;

        for run in 0..16 {
            let mut graph = CodeGraph::new(NodeId::directory(""));
            py_file(&mut graph, "shared/util.py");
            graph.add_node(CodeNode::File {
                id: NodeId::file("shared/util.ts"),
                name: "shared/util.ts".to_string(),
                path: "shared/util.ts".to_string(),
                language: Some(Language::TypeScript),
                children: Vec::new(),
            });
            graph.add_node(CodeNode::File {
                id: NodeId::file("shared/app.ts"),
                name: "shared/app.ts".to_string(),
                path: "shared/app.ts".to_string(),
                language: Some(Language::TypeScript),
                children: Vec::new(),
            });

            let refs = vec![import_ref("shared/app.ts", "./util")];
            let (edges, _map) = ImportResolver::resolve(&graph, &refs);

            assert_eq!(edges.len(), 1, "expected one import edge on run {run}");
            match &seen {
                None => seen = Some(edges[0].target.clone()),
                Some(first) => assert_eq!(
                    &edges[0].target, first,
                    "polyglot collision resolved differently on run {run}"
                ),
            }
        }
    }

    #[test]
    fn python_relative_import_of_stub_package_resolves() {
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "pkg/a.py");
        py_file(&mut graph, "pkg/stubpkg/__init__.pyi");

        let refs = vec![import_ref("pkg/a.py", ".stubpkg")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("pkg/stubpkg/__init__.pyi"));
    }

    #[test]
    fn python_third_party_import_does_not_resolve() {
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "src/mypkg/__init__.py");
        py_file(&mut graph, "src/mypkg/app.py");

        let refs = vec![
            import_ref("src/mypkg/app.py", "os"),
            import_ref("src/mypkg/app.py", "numpy"),
            import_ref("src/mypkg/app.py", "os.path"),
        ];
        let (edges, map) = ImportResolver::resolve(&graph, &refs);

        assert!(
            edges.is_empty(),
            "stdlib/third-party imports must not resolve"
        );
        assert!(map.is_empty());
    }

    #[test]
    fn python_multi_import_emits_one_edge_per_module() {
        // Per the extractor contract, `import mypkg.mod, mypkg.other` produces
        // one Import ref per module.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "src/mypkg/__init__.py");
        py_file(&mut graph, "src/mypkg/app.py");
        py_file(&mut graph, "src/mypkg/mod.py");
        py_file(&mut graph, "src/mypkg/other.py");

        let refs = vec![
            import_ref("src/mypkg/app.py", "mypkg.mod"),
            import_ref("src/mypkg/app.py", "mypkg.other"),
        ];
        let (edges, map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 2);
        assert_eq!(map["src/mypkg/app.py"].len(), 2);
    }

    #[test]
    fn python_self_import_emits_no_edge() {
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "src/mypkg/__init__.py");
        py_file(&mut graph, "src/mypkg/app.py");

        let refs = vec![import_ref("src/mypkg/app.py", "mypkg.app")];
        let (edges, map) = ImportResolver::resolve(&graph, &refs);

        assert!(edges.is_empty());
        assert!(map.is_empty());
    }

    #[test]
    fn python_nested_package_chain_root_is_outermost_parent() {
        // proj/pkg and proj/pkg/sub are packages; `proj` is the root, so an
        // absolute `pkg.sub.m` import resolves through it.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "proj/pkg/__init__.py");
        py_file(&mut graph, "proj/pkg/app.py");
        py_file(&mut graph, "proj/pkg/sub/__init__.py");
        py_file(&mut graph, "proj/pkg/sub/m.py");

        let refs = vec![import_ref("proj/pkg/app.py", "pkg.sub.m")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("proj/pkg/sub/m.py"));
    }

    #[test]
    fn rust_use_path_is_unaffected_by_python_absolute_branch() {
        // A Rust file in a repo that also has Python packages must still take
        // the Rust branch.
        let mut graph = CodeGraph::new(NodeId::directory(""));
        py_file(&mut graph, "src/mypkg/__init__.py");
        rs_file(&mut graph, "src/main.rs");
        rs_file(&mut graph, "src/model/mod.rs");

        let refs = vec![import_ref("src/main.rs", "crate::model::CodeGraph")];
        let (edges, _map) = ImportResolver::resolve(&graph, &refs);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, NodeId::file("src/model/mod.rs"));
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
        assert_eq!(
            edges[0].target,
            NodeId::file("crates/core/src/model/graph.rs")
        );
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
