//! Detection of Python *package roots* — the directories that a Python
//! absolute (non-relative) import is resolved against.
//!
//! Python resolves `import mypkg.mod` by searching `sys.path`, which at runtime
//! typically contains the project root, an installed `src/` directory, or each
//! `packages/*/` of a monorepo. A static scan has no `sys.path`, so this module
//! reconstructs the plausible set from the scanned file paths alone:
//!
//! - the repository root is always a candidate;
//! - every directory literally named `src` is a candidate (the ubiquitous
//!   "src layout", where `src` is never itself a package);
//! - for every package directory (one containing `__init__.py`/`__init__.pyi`)
//!   we walk up while the parent is *also* a package; the parent of the topmost
//!   package in that chain is a candidate root.
//!
//! Candidates are then ordered per importing file, nearest first, so a
//! monorepo resolves each package against its own root before falling back.

use std::collections::{BTreeSet, HashSet};

/// Files whose presence marks a directory as a Python package.
const PACKAGE_MARKERS: &[&str] = &["__init__.py", "__init__.pyi"];

/// Directory names that hold source but are never themselves importable
/// packages, so their contents sit directly on the import path.
const IMPLICIT_ROOT_DIR_NAMES: &[&str] = &["src"];

/// The set of candidate roots that Python absolute imports resolve against.
///
/// Paths are repository-relative, `/`-separated, and never have a trailing
/// slash. The repository root is represented by the empty string.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PythonPackageRoots {
    /// Sorted + deduplicated for deterministic ordering.
    roots: BTreeSet<String>,
}

impl PythonPackageRoots {
    /// Derive the candidate roots from the repository-relative paths of every
    /// scanned file.
    pub fn from_file_paths<I, S>(paths: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut roots: BTreeSet<String> = BTreeSet::new();
        // The repository root is always on the import path.
        roots.insert(String::new());

        let mut package_dirs: HashSet<String> = HashSet::new();

        for path in paths {
            let path = path.as_ref();
            let (dir, file_name) = split_parent(path);

            if PACKAGE_MARKERS.contains(&file_name) {
                package_dirs.insert(dir.to_string());
            }

            // Any ancestor directory literally named `src` is a root.
            let mut ancestor = dir;
            loop {
                if IMPLICIT_ROOT_DIR_NAMES.contains(&last_component(ancestor)) {
                    roots.insert(ancestor.to_string());
                }
                if ancestor.is_empty() {
                    break;
                }
                ancestor = parent_of(ancestor);
            }
        }

        // For each package, the root is the parent of the topmost package in
        // its unbroken `__init__.py` chain.
        for dir in &package_dirs {
            let mut top = dir.as_str();
            loop {
                if top.is_empty() {
                    break;
                }
                let parent = parent_of(top);
                if package_dirs.contains(parent) {
                    top = parent;
                } else {
                    break;
                }
            }
            roots.insert(parent_of(top).to_string());
        }

        Self { roots }
    }

    /// All candidate roots, sorted. The empty string denotes the repo root.
    pub fn roots(&self) -> impl Iterator<Item = &str> {
        self.roots.iter().map(String::as_str)
    }

    /// The candidate roots ordered for an import appearing in `from_file`:
    /// roots containing the importing file come first (deepest first), then
    /// the remaining roots (also deepest first). Ties break lexicographically
    /// so the ordering is total and deterministic.
    pub fn ordered_for(&self, from_file: &str) -> Vec<&str> {
        let from_dir = split_parent(from_file).0;

        let mut ordered: Vec<&str> = self.roots.iter().map(String::as_str).collect();
        ordered.sort_by(|a, b| {
            let key = |root: &str| {
                (
                    // 0 = contains the importing file, 1 = elsewhere.
                    u8::from(!contains(root, from_dir)),
                    // Deepest root first: more specific wins.
                    std::cmp::Reverse(depth(root)),
                )
            };
            key(a).cmp(&key(b)).then_with(|| a.cmp(b))
        });
        ordered
    }
}

/// Split a `/`-separated relative path into `(parent_dir, file_name)`.
fn split_parent(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(idx) => (&path[..idx], &path[idx + 1..]),
        None => ("", path),
    }
}

/// The parent directory of a `/`-separated relative directory path.
fn parent_of(dir: &str) -> &str {
    split_parent(dir).0
}

/// The final path component of a directory path (empty for the repo root).
fn last_component(dir: &str) -> &str {
    split_parent(dir).1
}

/// Number of path components; the repo root has depth 0.
fn depth(dir: &str) -> usize {
    if dir.is_empty() {
        0
    } else {
        dir.split('/').count()
    }
}

/// Whether `dir` is `root` itself or lives underneath it.
fn contains(root: &str, dir: &str) -> bool {
    if root.is_empty() {
        return true;
    }
    dir == root
        || (dir.len() > root.len() && dir.starts_with(root) && dir.as_bytes()[root.len()] == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots_of(paths: &[&str]) -> Vec<String> {
        PythonPackageRoots::from_file_paths(paths.iter().copied())
            .roots()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn repo_root_is_always_a_candidate() {
        assert_eq!(roots_of(&["README.md"]), vec![String::new()]);
    }

    #[test]
    fn src_layout_yields_src_as_root() {
        let roots = roots_of(&[
            "src/mypkg/__init__.py",
            "src/mypkg/app.py",
            "src/mypkg/sub/__init__.py",
            "tests/test_app.py",
        ]);
        assert_eq!(roots, vec![String::new(), "src".to_string()]);
    }

    #[test]
    fn flat_layout_yields_only_repo_root() {
        let roots = roots_of(&["flatpkg/__init__.py", "flatpkg/util.py", "main.py"]);
        assert_eq!(roots, vec![String::new()]);
    }

    #[test]
    fn nested_package_chain_walks_up_to_the_outermost_package() {
        // proj/pkg and proj/pkg/sub are both packages; proj is not.
        let roots = roots_of(&[
            "proj/pkg/__init__.py",
            "proj/pkg/sub/__init__.py",
            "proj/pkg/sub/m.py",
        ]);
        assert_eq!(roots, vec![String::new(), "proj".to_string()]);
    }

    #[test]
    fn monorepo_layout_yields_one_root_per_package_dir() {
        let roots = roots_of(&[
            "packages/svc/svc/__init__.py",
            "packages/svc/svc/core.py",
            "packages/web/web/__init__.py",
            "packages/web/web/app.py",
        ]);
        assert_eq!(
            roots,
            vec![
                String::new(),
                "packages/svc".to_string(),
                "packages/web".to_string()
            ]
        );
    }

    #[test]
    fn src_dir_is_a_root_even_without_init_files() {
        let roots = roots_of(&["src/loose_module.py"]);
        assert_eq!(roots, vec![String::new(), "src".to_string()]);
    }

    #[test]
    fn nested_src_dirs_are_each_roots() {
        let roots = roots_of(&["backend/src/a.py", "frontend/src/b.py"]);
        assert_eq!(
            roots,
            vec![
                String::new(),
                "backend/src".to_string(),
                "frontend/src".to_string()
            ]
        );
    }

    #[test]
    fn ordering_prefers_the_root_containing_the_importing_file() {
        let roots = PythonPackageRoots::from_file_paths([
            "src/mypkg/__init__.py",
            "src/mypkg/app.py",
            "tests/test_app.py",
        ]);
        assert_eq!(roots.ordered_for("src/mypkg/app.py"), vec!["src", ""]);
        // `src` does not contain the test file, so the repo root is tried first.
        assert_eq!(roots.ordered_for("tests/test_app.py"), vec!["", "src"]);
    }

    #[test]
    fn ordering_prefers_the_deepest_containing_root() {
        let roots = PythonPackageRoots::from_file_paths([
            "packages/svc/svc/__init__.py",
            "packages/svc/svc/core.py",
            "packages/web/web/__init__.py",
        ]);
        let ordered = roots.ordered_for("packages/svc/svc/core.py");
        assert_eq!(ordered[0], "packages/svc");
    }

    #[test]
    fn contains_matches_only_whole_components() {
        assert!(contains("", "anything"));
        assert!(contains("src", "src"));
        assert!(contains("src", "src/mypkg"));
        assert!(!contains("src", "srcfoo"));
        assert!(!contains("src", "other/src"));
    }
}
