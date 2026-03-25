use std::fs;

use cc_core::model::{CodeNode, Language, NodeId};
use cc_core::parser::Extractor;
use cc_core::repo::RepoScanner;
use cc_core::resolver::SymbolTable;

#[test]
fn test_end_to_end_scan_parse_resolve() {
    let tmp = tempfile::tempdir().expect("failed to create temp dir");
    let root = tmp.path();

    // Create sample project structure
    fs::create_dir_all(root.join("src")).expect("failed to create src dir");

    fs::write(
        root.join("src/main.py"),
        "from utils import helper\n\ndef main():\n    helper()\n",
    )
    .expect("failed to write main.py");

    fs::write(root.join("src/utils.py"), "def helper():\n    pass\n")
        .expect("failed to write utils.py");

    // Step 1: Scan the repository
    let mut graph = RepoScanner::scan(root).expect("scan should succeed");

    // Verify directory and file nodes exist
    assert!(
        graph.nodes.contains_key(&NodeId::directory("")),
        "root directory node should exist"
    );
    assert!(
        graph.nodes.contains_key(&NodeId::file("src/main.py")),
        "main.py file node should exist"
    );
    assert!(
        graph.nodes.contains_key(&NodeId::file("src/utils.py")),
        "utils.py file node should exist"
    );

    // Count directory and file nodes
    let dir_count = graph.nodes.values().filter(|n| n.is_directory()).count();
    let file_count = graph.nodes.values().filter(|n| n.is_file()).count();
    assert!(
        dir_count >= 2,
        "expected at least 2 directory nodes (root + src)"
    );
    assert!(file_count >= 2, "expected at least 2 file nodes");

    // Step 2: Extract code blocks from each file
    let mut all_refs = Vec::new();

    // Collect file info first to avoid borrow issues
    let file_infos: Vec<(NodeId, String, Language)> = graph
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

    for (file_id, path, lang) in &file_infos {
        let source = fs::read_to_string(root.join(path)).expect("failed to read source file");
        let (nodes, refs) =
            Extractor::extract_file(path, &source, lang).expect("extraction should succeed");

        for code_node in nodes {
            let child_id = code_node.id().clone();
            // Add child reference to parent
            if let Some(parent) = graph.nodes.get_mut(file_id) {
                parent.children_mut().push(child_id);
            }
            graph.add_node(code_node);
        }

        all_refs.extend(refs);
    }

    // Verify code block nodes were added
    let code_block_count = graph.nodes.values().filter(|n| n.is_code_block()).count();
    assert!(
        code_block_count >= 2,
        "expected at least 2 code blocks (main + helper), got {}",
        code_block_count
    );

    // Step 3: Build symbol table and resolve references
    let symbol_table = SymbolTable::build_from_graph(&graph);

    // Verify symbols were registered
    assert!(
        symbol_table.symbols.contains_key("main"),
        "symbol table should contain 'main'"
    );
    assert!(
        symbol_table.symbols.contains_key("helper"),
        "symbol table should contain 'helper'"
    );

    let edges = symbol_table.resolve_references(&all_refs);

    // Add resolved edges to graph
    for edge in &edges {
        graph.add_edge(edge.clone());
    }

    // Verify at least one resolved edge exists (helper() call from main -> helper def)
    assert!(
        graph.edge_count() >= 1,
        "expected at least one resolved edge, got {}",
        graph.edge_count()
    );

    // Overall graph integrity: has directories, files, code blocks, and edges
    assert!(dir_count >= 2);
    assert!(file_count >= 2);
    assert!(code_block_count >= 2);
    assert!(graph.edge_count() >= 1);
}
