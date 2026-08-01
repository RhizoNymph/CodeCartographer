use std::collections::HashSet;
use std::path::PathBuf;

use cc_core::model::{
    CodeGraph, CodeNode, EdgeKind, FocusDirection, Language, Neighborhood, NodeId, ParseResult,
    SubGraph,
};
use cc_core::parser::{Extractor, ParseEvent};
use cc_core::resolver::{ImportResolver, SymbolTable};
use rayon::prelude::*;
use tauri::command;
use tauri::ipc::Channel;

use crate::GraphState;

#[command]
pub async fn parse_repo(
    path: String,
    on_event: Channel<ParseEvent>,
    state: tauri::State<'_, GraphState>,
) -> Result<ParseResult, String> {
    let root = PathBuf::from(&path);

    // Take the graph from server-side state
    let mut graph = {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        guard
            .take()
            .ok_or_else(|| "No graph in state. Run scan_repo first.".to_string())?
    };

    // Re-parse guard: strip any state left by a previous parse so that parsing
    // the same repo twice is idempotent. Remove all CodeBlock nodes, drop block
    // ids from File children arrays, clear edges, and rebuild adjacency.
    strip_parsed_state(&mut graph);

    let mut all_refs = Vec::new();
    let mut total_blocks = 0usize;
    let mut total_files = 0usize;

    // Collect file nodes with languages
    let file_nodes: Vec<(NodeId, String, Language)> = graph
        .nodes
        .iter()
        .filter_map(|(id, node)| {
            if let CodeNode::File {
                path,
                language: Some(lang),
                ..
            } = node
            {
                Some((id.clone(), path.clone(), lang.clone()))
            } else {
                None
            }
        })
        .collect();

    // Phase 1: Parse files in parallel (I/O + tree-sitter)
    let parse_results: Vec<_> = file_nodes
        .par_iter()
        .map(|(file_id, rel_path, language)| {
            let abs_path = root.join(rel_path);
            let source = match std::fs::read_to_string(&abs_path) {
                Ok(s) => s,
                Err(e) => return (file_id.clone(), rel_path.clone(), Err(e.to_string())),
            };
            match Extractor::extract_file(rel_path, &source, language) {
                Ok((nodes, refs)) => (file_id.clone(), rel_path.clone(), Ok((nodes, refs))),
                Err(e) => (file_id.clone(), rel_path.clone(), Err(e.to_string())),
            }
        })
        .collect();

    // Phase 2: Merge results and send progress events sequentially
    for (file_id, rel_path, result) in parse_results {
        let _ = on_event.send(ParseEvent::FileStart {
            path: rel_path.clone(),
        });
        match result {
            Ok((nodes, refs)) => {
                let block_count = nodes.len();
                total_blocks += block_count;
                for node in nodes {
                    // Only top-level blocks (parented directly to the file) are
                    // added to the File node's children. Nested blocks are already
                    // linked into their parent block's children by the extractor.
                    let is_top_level = matches!(
                        &node,
                        CodeNode::CodeBlock { parent, .. } if *parent == file_id
                    );
                    let block_id = node.id().clone();
                    graph.add_node(node);
                    if is_top_level {
                        if let Some(file_node) = graph.nodes.get_mut(&file_id) {
                            file_node.children_mut().push(block_id);
                        }
                    }
                }
                all_refs.extend(refs);
                let _ = on_event.send(ParseEvent::FileDone {
                    path: rel_path,
                    blocks: block_count,
                });
            }
            Err(e) => {
                let _ = on_event.send(ParseEvent::Error {
                    path: rel_path,
                    message: e,
                });
            }
        }
        total_files += 1;
    }

    // Resolve references into edges
    let symbol_table = SymbolTable::build_from_graph(&graph);

    // Debug: show some refs and symbols (only when DEBUG level is enabled)
    if tracing::event_enabled!(tracing::Level::DEBUG) {
        if !all_refs.is_empty() {
            tracing::debug!("Sample refs (first 5):");
            for r in all_refs.iter().take(5) {
                tracing::debug!("  ref: '{}' from {:?}", r.name, r.from_node);
            }
        }
        if !symbol_table.symbols.is_empty() {
            tracing::debug!("Sample symbols (first 5):");
            for (name, ids) in symbol_table.symbols.iter().take(5) {
                tracing::debug!("  sym: '{}' -> {:?}", name, ids);
            }
        }
    }

    // Resolve import paths FIRST: this yields file-level import edges and an
    // import map (source file -> imported files) that the symbol resolver uses
    // as the "imported" tier of its precision ladder.
    let (import_edges, import_map) = ImportResolver::resolve(&graph, &all_refs);
    tracing::info!("Resolved {} file-level import edges", import_edges.len());
    for edge in &import_edges {
        graph.add_edge(edge.clone());
    }
    tracing::info!("Graph now has {} edges after adding", graph.edges.len());

    // Resolve references into edges via the precision ladder (uses import_map),
    // so each edge carries a Resolution confidence.
    let edges = symbol_table.resolve_references(&all_refs, &import_map);
    tracing::info!(
        "Resolved {} refs into {} edges (symbols: {})",
        all_refs.len(),
        edges.len(),
        symbol_table.symbols.len()
    );
    for edge in &edges {
        graph.add_edge(edge.clone());
    }

    tracing::info!("Graph now has {} edges after adding", graph.edges.len());

    if let Err(e) = on_event.send(ParseEvent::Complete {
        total_files,
        total_blocks,
    }) {
        tracing::warn!(error = %e, "Failed to send parse event");
    }

    // Build the edge-less response from the graph, then hand ownership of the
    // graph to server-side state (no extra clone of the full graph).
    let result = ParseResult::from_graph(&graph);
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        *guard = Some(graph);
    }

    Ok(result)
}

/// Remove all parse-derived state from the graph so that re-parsing is
/// idempotent: drop every CodeBlock node, remove block ids from File children
/// arrays, clear all edges, and rebuild adjacency indexes. Directory and File
/// nodes (produced by the scan phase) are preserved.
fn strip_parsed_state(graph: &mut CodeGraph) {
    // Collect ids of all code-block nodes.
    let block_ids: HashSet<NodeId> = graph
        .nodes
        .iter()
        .filter(|(_, node)| node.is_code_block())
        .map(|(id, _)| id.clone())
        .collect();

    if block_ids.is_empty() && graph.edges.is_empty() {
        return;
    }

    // Remove the code-block nodes.
    graph.nodes.retain(|_, node| !node.is_code_block());

    // Remove block ids from every remaining node's children (File nodes only
    // ever reference blocks, but this is safe for all node kinds).
    for node in graph.nodes.values_mut() {
        node.children_mut().retain(|child| !block_ids.contains(child));
    }

    // Clear edges and rebuild the (now empty) adjacency indexes.
    graph.edges.clear();
    graph.rebuild_adjacency();
}

/// Compute the direct + aggregated edges for a render view from server-side
/// graph state. `render_ids` are the node ids present in the frontend's ELK
/// layout tree (visible nodes whose ancestors are all expanded); `edge_kinds`
/// is the set of enabled edge-kind names.
#[command]
pub async fn get_subgraph(
    render_ids: Vec<String>,
    edge_kinds: Vec<String>,
    state: tauri::State<'_, GraphState>,
) -> Result<SubGraph, String> {
    let guard = state
        .0
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    let graph = guard
        .as_ref()
        .ok_or_else(|| "No graph in state. Run scan_repo first.".to_string())?;

    let render: Vec<NodeId> = render_ids.into_iter().map(NodeId).collect();
    let kinds = parse_edge_kinds(edge_kinds)?;

    Ok(SubGraph::from_graph(graph, &render, &kinds))
}

/// Parse a list of edge-kind names into a set of `EdgeKind`, erroring on any
/// unknown name. Shared by `get_subgraph` and `get_neighborhood`.
fn parse_edge_kinds(edge_kinds: Vec<String>) -> Result<HashSet<EdgeKind>, String> {
    edge_kinds
        .into_iter()
        .map(|s| match s.as_str() {
            "Import" => Ok(EdgeKind::Import),
            "FunctionCall" => Ok(EdgeKind::FunctionCall),
            "MethodCall" => Ok(EdgeKind::MethodCall),
            "TypeReference" => Ok(EdgeKind::TypeReference),
            "Inheritance" => Ok(EdgeKind::Inheritance),
            "TraitImpl" => Ok(EdgeKind::TraitImpl),
            "VariableUsage" => Ok(EdgeKind::VariableUsage),
            other => Err(format!("Unknown edge kind: {}", other)),
        })
        .collect()
}

/// Compute the local neighborhood around `node_id` for focus / drill-down. BFS
/// over forward and/or reverse adjacency per `direction` ("both" | "upstream" |
/// "downstream"), bounded by `depth` (clamped to 1..=2) and filtered to
/// `edge_kinds`. Returns the neighborhood node ids (including the container
/// chain up to the root) and the direct edges among them (carrying resolution).
/// Errors if the node is unknown.
#[command]
pub async fn get_neighborhood(
    node_id: String,
    depth: u8,
    edge_kinds: Vec<String>,
    direction: FocusDirection,
    state: tauri::State<'_, GraphState>,
) -> Result<Neighborhood, String> {
    let guard = state
        .0
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    let graph = guard
        .as_ref()
        .ok_or_else(|| "No graph in state. Run scan_repo first.".to_string())?;

    let kinds = parse_edge_kinds(edge_kinds)?;
    let focus = NodeId(node_id);

    graph
        .neighborhood(&focus, depth, &kinds, direction)
        .ok_or_else(|| format!("Unknown node: {}", focus))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_core::model::{
        BlockKind, CodeEdge, CodeNode, EdgeKind, NodeId, Resolution, Span, Visibility,
    };

    fn file_node(id: &str) -> CodeNode {
        CodeNode::File {
            id: NodeId::file(id),
            name: id.to_string(),
            path: id.to_string(),
            language: Some(Language::Python),
            children: Vec::new(),
        }
    }

    fn block_node(id: &str, parent: NodeId) -> CodeNode {
        CodeNode::CodeBlock {
            id: NodeId(id.to_string()),
            name: id.to_string(),
            kind: BlockKind::Function,
            span: Span {
                start_line: 1,
                start_col: 0,
                end_line: 1,
                end_col: 0,
            },
            signature: None,
            visibility: Some(Visibility::Public),
            parent,
            children: Vec::new(),
        }
    }

    /// Build a "parsed" graph: one file with a block child and one edge, then
    /// assert strip_parsed_state returns it to the pre-parse (scan-only) state.
    #[test]
    fn strip_parsed_state_removes_blocks_edges_and_children() {
        let file_id = NodeId::file("a.py");
        let block_id = NodeId("a.py::foo@1".into());

        let mut graph = CodeGraph::new(file_id.clone());
        let mut file = file_node("a.py");
        file.children_mut().push(block_id.clone());
        graph.add_node(file);
        graph.add_node(block_node("a.py::foo@1", file_id.clone()));
        graph.add_edge(CodeEdge {
            source: file_id.clone(),
            target: block_id.clone(),
            kind: EdgeKind::FunctionCall,
            weight: 1,
            resolution: Resolution::GlobalUnique,
        });

        strip_parsed_state(&mut graph);

        assert_eq!(graph.nodes.len(), 1, "only the file node should remain");
        assert!(graph.nodes.contains_key(&file_id));
        assert!(graph.edges.is_empty(), "edges should be cleared");
        assert!(
            graph.forward_adj.is_empty() && graph.reverse_adj.is_empty(),
            "adjacency should be rebuilt empty"
        );
        let file = graph.nodes.get(&file_id).unwrap();
        assert!(
            file.children().is_empty(),
            "block ids should be removed from file children"
        );
    }

    /// Strip twice: second call is a no-op and leaves an identical graph.
    #[test]
    fn strip_parsed_state_is_idempotent() {
        let file_id = NodeId::file("a.py");
        let block_id = NodeId("a.py::foo@1".into());

        let mut graph = CodeGraph::new(file_id.clone());
        let mut file = file_node("a.py");
        file.children_mut().push(block_id.clone());
        graph.add_node(file);
        graph.add_node(block_node("a.py::foo@1", file_id.clone()));
        graph.add_edge(CodeEdge {
            source: file_id.clone(),
            target: block_id,
            kind: EdgeKind::FunctionCall,
            weight: 1,
            resolution: Resolution::GlobalUnique,
        });

        strip_parsed_state(&mut graph);
        let node_count = graph.node_count();
        let edge_count = graph.edge_count();
        strip_parsed_state(&mut graph);

        assert_eq!(graph.node_count(), node_count);
        assert_eq!(graph.edge_count(), edge_count);
    }
}
