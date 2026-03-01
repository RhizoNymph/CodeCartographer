use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;

use crate::model::{CodeGraph, CodeNode, Language, NodeId};

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
                let ext = abs_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
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

        tracing::info!(
            "Scanned repository: {} nodes",
            graph.node_count()
        );

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
}
