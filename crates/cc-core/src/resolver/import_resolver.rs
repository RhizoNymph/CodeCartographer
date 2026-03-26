use std::collections::HashMap;
use std::path::Path;

use crate::model::{CodeEdge, CodeGraph, CodeNode, EdgeKind, Language, NodeId};
use crate::parser::{RawRefKind, RawReference};

use super::extension_probe::{probe_path, probe_path_all};

/// Resolves import statements to their target files/modules.
pub struct ImportResolver;

impl ImportResolver {
    /// Resolve import references into CodeEdges.
    pub fn resolve(graph: &CodeGraph, refs: &[RawReference]) -> Vec<CodeEdge> {
        let mut edges = Vec::new();

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
                        edges.push(CodeEdge {
                            source: source_file_id,
                            target: target_id,
                            kind: EdgeKind::Import,
                            weight: 1,
                        });
                    }
                }
            }
        }

        // Deduplicate edges
        edges.sort_by(|a, b| (&a.source.0, &a.target.0).cmp(&(&b.source.0, &b.target.0)));
        edges.dedup_by(|a, b| a.source == b.source && a.target == b.target);

        edges
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

        // Handle Rust crate-level imports (crate::foo::bar)
        if module_path.starts_with("crate::") {
            let parts: Vec<&str> = module_path
                .strip_prefix("crate::")
                .unwrap()
                .split("::")
                .collect();
            let as_path = format!("src/{}", parts.join("/"));
            return probe_path(&as_path, Language::Rust, path_map);
        }

        // Bare module name lookup
        if let Some(id) = path_map.get(module_path) {
            return Some(id.clone());
        }

        None
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
