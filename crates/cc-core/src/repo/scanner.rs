use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ignore::{DirEntry, WalkBuilder};

use crate::model::{CodeGraph, CodeNode, Language, NodeId};

/// Why a directory is excluded from a repository scan.
///
/// `.gitignore` alone is not enough: virtualenvs, byte caches and build output
/// are frequently present in directories that have no `.gitignore` at all (an
/// opened folder need not even be a git repo), and scanning them means parsing
/// thousands of files that are not the user's source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirIgnoreRule {
    /// Never source: virtualenvs, caches, packaging metadata.
    Always,
    /// Ambiguous name that is usually build output but is occasionally a real
    /// package (`build/`, `dist/`). Excluded only when the directory is *not*
    /// itself a Python package, so `mypkg/build/__init__.py` survives.
    ///
    /// Tradeoff: a non-Python `build/` directory that genuinely holds hand
    /// written source (e.g. build scripts a user wants graphed) is skipped.
    /// That is the deliberate choice — the false-positive cost (thousands of
    /// generated files) far outweighs the false-negative cost.
    UnlessPythonPackage,
}

/// Directory names that are never source, regardless of contents.
const ALWAYS_IGNORED_DIRS: &[&str] = &[
    "__pycache__",
    "venv",
    ".venv",
    "site-packages",
    ".eggs",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".ipynb_checkpoints",
];

/// Directory names that are build output unless they are a Python package.
const AMBIGUOUS_BUILD_DIRS: &[&str] = &["build", "dist"];

/// Files whose presence marks a directory as a Python package.
const PACKAGE_MARKERS: &[&str] = &["__init__.py", "__init__.pyi"];

/// The ignore rule for a directory *name*, if any.
///
/// Matching is on directory names only — a file called `build` or `venv.py` is
/// always kept.
pub fn dir_ignore_rule(name: &str) -> Option<DirIgnoreRule> {
    if ALWAYS_IGNORED_DIRS.contains(&name) || name.ends_with(".egg-info") {
        return Some(DirIgnoreRule::Always);
    }
    if AMBIGUOUS_BUILD_DIRS.contains(&name) {
        return Some(DirIgnoreRule::UnlessPythonPackage);
    }
    None
}

/// Whether a directory is a Python package (has an `__init__.py`/`.pyi`).
fn is_python_package_dir(dir: &Path) -> bool {
    PACKAGE_MARKERS
        .iter()
        .any(|marker| dir.join(marker).is_file())
}

/// Walk filter: drop ignored directories (and, transitively, their subtrees).
fn keep_entry(entry: &DirEntry) -> bool {
    // Never filter out the scan root itself, whatever it is called.
    if entry.depth() == 0 {
        return true;
    }
    if !entry.file_type().is_some_and(|ft| ft.is_dir()) {
        return true;
    }
    let Some(name) = entry.file_name().to_str() else {
        return true;
    };

    let keep = match dir_ignore_rule(name) {
        None => true,
        Some(DirIgnoreRule::Always) => false,
        Some(DirIgnoreRule::UnlessPythonPackage) => is_python_package_dir(entry.path()),
    };
    if !keep {
        tracing::debug!(dir = %entry.path().display(), rule = ?dir_ignore_rule(name), "skipping directory");
    }
    keep
}

/// Scans a repository directory and builds the file/directory hierarchy.
pub struct RepoScanner;

impl RepoScanner {
    /// Scan a repository directory tree, respecting .gitignore.
    /// Returns a CodeGraph containing Directory and File nodes.
    pub fn scan(root: &Path) -> anyhow::Result<CodeGraph> {
        let root = root.canonicalize()?;
        let root_name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "root".to_string());

        let root_id = NodeId::directory("");
        let mut graph = CodeGraph::new(root_id.clone());

        // Add root directory node
        graph.add_node(CodeNode::Directory {
            id: root_id.clone(),
            name: root_name,
            path: String::new(),
            children: Vec::new(),
        });

        // Track directory nodes we've created
        let mut dir_nodes: HashMap<PathBuf, NodeId> = HashMap::new();
        dir_nodes.insert(PathBuf::new(), root_id.clone());

        // Walk the directory tree
        let walker = WalkBuilder::new(&root)
            .hidden(true) // skip hidden files
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .sort_by_file_path(|a, b| a.cmp(b))
            .filter_entry(keep_entry)
            .build();

        for entry in walker {
            let entry = entry?;
            let abs_path = entry.path();

            // Skip the root itself
            if abs_path == root {
                continue;
            }

            let rel_path = abs_path.strip_prefix(&root)?;
            let rel_str = rel_path.to_string_lossy().to_string();
            let name = abs_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            // Determine parent relative path
            let parent_rel = rel_path
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_default();

            // Ensure all ancestor directories exist
            Self::ensure_ancestors(&root, &parent_rel, &mut graph, &mut dir_nodes);

            let parent_id = dir_nodes
                .get(&parent_rel)
                .cloned()
                .unwrap_or_else(|| root_id.clone());

            if abs_path.is_dir() {
                let dir_id = NodeId::directory(&rel_str);
                graph.add_node(CodeNode::Directory {
                    id: dir_id.clone(),
                    name,
                    path: rel_str,
                    children: Vec::new(),
                });
                dir_nodes.insert(rel_path.to_path_buf(), dir_id.clone());

                // Add as child of parent
                if let Some(parent_node) = graph.nodes.get_mut(&parent_id) {
                    parent_node.children_mut().push(dir_id);
                }
            } else if abs_path.is_file() {
                let ext = abs_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                let language = Language::from_extension(ext);

                let file_id = NodeId::file(&rel_str);
                graph.add_node(CodeNode::File {
                    id: file_id.clone(),
                    name,
                    path: rel_str,
                    language,
                    children: Vec::new(),
                });

                // Add as child of parent
                if let Some(parent_node) = graph.nodes.get_mut(&parent_id) {
                    parent_node.children_mut().push(file_id);
                }
            }
        }

        tracing::info!("Scanned repository: {} nodes", graph.node_count());

        Ok(graph)
    }

    /// Ensure all ancestor directories have nodes in the graph.
    fn ensure_ancestors(
        root: &Path,
        rel_path: &Path,
        graph: &mut CodeGraph,
        dir_nodes: &mut HashMap<PathBuf, NodeId>,
    ) {
        let mut ancestors: Vec<PathBuf> = Vec::new();
        let mut current = rel_path.to_path_buf();

        // Collect ancestors that don't exist yet
        while !current.as_os_str().is_empty() && !dir_nodes.contains_key(&current) {
            ancestors.push(current.clone());
            current = current
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_default();
        }

        // Create them from top to bottom
        for ancestor in ancestors.into_iter().rev() {
            let rel_str = ancestor.to_string_lossy().to_string();
            let name = ancestor
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            let parent_rel = ancestor
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_default();

            let dir_id = NodeId::directory(&rel_str);
            let parent_id = dir_nodes
                .get(&parent_rel)
                .cloned()
                .unwrap_or_else(|| NodeId::directory(""));

            // Check if the path actually exists as a directory
            let abs = root.join(&ancestor);
            if abs.is_dir() {
                graph.add_node(CodeNode::Directory {
                    id: dir_id.clone(),
                    name,
                    path: rel_str,
                    children: Vec::new(),
                });

                if let Some(parent_node) = graph.nodes.get_mut(&parent_id) {
                    parent_node.children_mut().push(dir_id.clone());
                }

                dir_nodes.insert(ancestor, dir_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_scan_temp_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        // Create a simple structure
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("src/lib.rs"), "pub mod foo;").unwrap();
        fs::create_dir_all(root.join("src/foo")).unwrap();
        fs::write(root.join("src/foo/mod.rs"), "pub fn bar() {}").unwrap();
        fs::write(root.join("Cargo.toml"), "[package]").unwrap();

        let graph = RepoScanner::scan(root).unwrap();

        // Should have: root dir + src dir + foo dir + 4 files = 7 nodes
        assert!(graph.node_count() >= 7);
        assert!(graph.nodes.contains_key(&NodeId::directory("")));
        assert!(graph.nodes.contains_key(&NodeId::file("src/main.rs")));
    }

    #[test]
    fn ignore_rules_classify_directory_names() {
        assert_eq!(dir_ignore_rule("__pycache__"), Some(DirIgnoreRule::Always));
        assert_eq!(dir_ignore_rule("venv"), Some(DirIgnoreRule::Always));
        assert_eq!(dir_ignore_rule(".venv"), Some(DirIgnoreRule::Always));
        assert_eq!(
            dir_ignore_rule("site-packages"),
            Some(DirIgnoreRule::Always)
        );
        assert_eq!(dir_ignore_rule(".tox"), Some(DirIgnoreRule::Always));
        assert_eq!(
            dir_ignore_rule("mypkg.egg-info"),
            Some(DirIgnoreRule::Always)
        );
        assert_eq!(
            dir_ignore_rule("build"),
            Some(DirIgnoreRule::UnlessPythonPackage)
        );
        assert_eq!(
            dir_ignore_rule("dist"),
            Some(DirIgnoreRule::UnlessPythonPackage)
        );
        // Legitimate names must never be caught.
        assert_eq!(dir_ignore_rule("src"), None);
        assert_eq!(dir_ignore_rule("builder"), None);
        assert_eq!(dir_ignore_rule("distributed"), None);
        assert_eq!(dir_ignore_rule("environment"), None);
    }

    #[test]
    fn scan_skips_python_junk_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        fs::create_dir_all(root.join("pkg/__pycache__")).unwrap();
        fs::create_dir_all(root.join("venv/lib/site-packages/vendored")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::create_dir_all(root.join("pkg.egg-info")).unwrap();
        fs::write(root.join("pkg/mod.py"), "x = 1\n").unwrap();
        fs::write(root.join("pkg/__pycache__/mod.py"), "x = 1\n").unwrap();
        fs::write(root.join("venv/lib/site-packages/vendored/v.py"), "y = 1\n").unwrap();
        fs::write(root.join("build/generated.py"), "z = 1\n").unwrap();
        fs::write(root.join("pkg.egg-info/PKG-INFO"), "Name: pkg\n").unwrap();

        let graph = RepoScanner::scan(root).unwrap();

        assert!(graph.nodes.contains_key(&NodeId::file("pkg/mod.py")));
        for skipped in [
            "pkg/__pycache__/mod.py",
            "venv/lib/site-packages/vendored/v.py",
            "build/generated.py",
            "pkg.egg-info/PKG-INFO",
        ] {
            assert!(
                !graph.nodes.contains_key(&NodeId::file(skipped)),
                "{skipped} should not be scanned"
            );
        }
        assert!(!graph.nodes.contains_key(&NodeId::directory("venv")));
        assert!(!graph.nodes.contains_key(&NodeId::directory("build")));
    }

    #[test]
    fn scan_keeps_a_python_package_named_build() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        fs::create_dir_all(root.join("pkg/build")).unwrap();
        fs::write(root.join("pkg/build/__init__.py"), "").unwrap();
        fs::write(root.join("pkg/build/real.py"), "def go(): pass\n").unwrap();

        let graph = RepoScanner::scan(root).unwrap();

        assert!(
            graph.nodes.contains_key(&NodeId::file("pkg/build/real.py")),
            "a `build` directory that is a Python package must be scanned"
        );
    }

    #[test]
    fn scan_keeps_files_named_like_ignored_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        fs::write(root.join("build"), "not a directory\n").unwrap();
        fs::write(root.join("venv.py"), "x = 1\n").unwrap();

        let graph = RepoScanner::scan(root).unwrap();

        assert!(graph.nodes.contains_key(&NodeId::file("build")));
        assert!(graph.nodes.contains_key(&NodeId::file("venv.py")));
    }

    #[test]
    fn scan_recognizes_pyi_stubs_as_python() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        fs::write(root.join("mod.pyi"), "def f() -> int: ...\n").unwrap();

        let graph = RepoScanner::scan(root).unwrap();

        match graph.nodes.get(&NodeId::file("mod.pyi")) {
            Some(CodeNode::File { language, .. }) => {
                assert_eq!(*language, Some(Language::Python));
            }
            other => panic!("expected a Python File node, got {other:?}"),
        }
    }
}
