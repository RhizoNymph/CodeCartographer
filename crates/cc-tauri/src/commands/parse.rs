use std::path::PathBuf;

use cc_core::model::{CodeGraph, CodeNode, EdgeKind, Language, NodeId, SubGraph};
use cc_core::parser::{Extractor, ParseEvent};
use cc_core::resolver::{ImportResolver, SymbolTable};
use rayon::prelude::*;
use tauri::command;
use tauri::ipc::Channel;

#[command]
pub async fn parse_repo(
    path: String,
    graph_json: String,
    on_event: Channel<ParseEvent>,
) -> Result<CodeGraph, String> {
    let root = PathBuf::from(&path);
    let mut graph: CodeGraph = serde_json::from_str(&graph_json).map_err(|e| e.to_string())?;
    graph.rebuild_adjacency();

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
                    let block_id = node.id().clone();
                    graph.add_node(node);
                    if let Some(file_node) = graph.nodes.get_mut(&file_id) {
                        file_node.children_mut().push(block_id);
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

    // Debug: show some refs and symbols
    if !all_refs.is_empty() {
        tracing::info!("Sample refs (first 5):");
        for r in all_refs.iter().take(5) {
            tracing::info!("  ref: '{}' from {:?}", r.name, r.from_node);
        }
    }
    if !symbol_table.symbols.is_empty() {
        tracing::info!("Sample symbols (first 5):");
        for (name, ids) in symbol_table.symbols.iter().take(5) {
            tracing::info!("  sym: '{}' -> {:?}", name, ids);
        }
    }

    let edges = symbol_table.resolve_references(&all_refs);
    tracing::info!(
        "Resolved {} refs into {} edges (symbols: {})",
        all_refs.len(),
        edges.len(),
        symbol_table.symbols.len()
    );
    for edge in &edges {
        graph.add_edge(edge.clone());
    }

    // Resolve import paths to file-level edges
    let import_edges = ImportResolver::resolve(&graph, &all_refs);
    tracing::info!("Resolved {} file-level import edges", import_edges.len());
    for edge in &import_edges {
        graph.add_edge(edge.clone());
    }

    tracing::info!("Graph now has {} edges after adding", graph.edges.len());

    if let Err(e) = on_event.send(ParseEvent::Complete {
        total_files,
        total_blocks,
    }) {
        tracing::warn!(error = %e, "Failed to send parse event");
    }

    Ok(graph)
}

// TODO: get_subgraph is registered as a Tauri command but not yet called from the
// frontend. It will become useful once server-side graph state is implemented so the
// frontend can request filtered subgraphs without sending the full graph over IPC.
#[command]
pub async fn get_subgraph(
    graph_json: String,
    visible_ids: Vec<String>,
    edge_kinds: Vec<String>,
) -> Result<SubGraph, String> {
    let graph: CodeGraph = serde_json::from_str(&graph_json).map_err(|e| e.to_string())?;

    let visible: Vec<NodeId> = visible_ids.into_iter().map(NodeId).collect();
    let kinds: Vec<EdgeKind> = edge_kinds
        .iter()
        .filter_map(|k| match k.as_str() {
            "Import" => Some(EdgeKind::Import),
            "FunctionCall" => Some(EdgeKind::FunctionCall),
            "MethodCall" => Some(EdgeKind::MethodCall),
            "TypeReference" => Some(EdgeKind::TypeReference),
            "Inheritance" => Some(EdgeKind::Inheritance),
            "TraitImpl" => Some(EdgeKind::TraitImpl),
            "VariableUsage" => Some(EdgeKind::VariableUsage),
            _ => None,
        })
        .collect();

    Ok(SubGraph::from_graph(&graph, &visible, &kinds))
}
