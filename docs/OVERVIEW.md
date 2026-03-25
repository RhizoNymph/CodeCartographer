Overview:
    description:
        CodeCartographer is a Tauri desktop application that visualizes code structure
        and dependencies as an interactive graph. It parses source code using Tree-sitter,
        builds a hierarchical graph of files, directories, and code blocks, then renders
        it using Pixi.js with ELK.js layout.

    subsystems:
        cc-core:
            The core parsing engine and graph model. Contains the data model (CodeGraph,
            CodeNode, CodeEdge), Tree-sitter parsing/extraction, repository scanning,
            symbol resolution, and reference-to-edge conversion.

        cc-tauri:
            Bridge layer exposing cc-core as Tauri IPC commands. Manages server-side
            graph state, orchestrates the scan/parse pipeline, and handles parallel
            file parsing via rayon.

        frontend (React/TypeScript):
            React UI with Zustand state management, Pixi.js WebGL rendering, ELK.js
            hierarchical layout, and a toolbar/sidebar for user interaction.

        tauri-app (src-tauri):
            Desktop application shell. Registers IPC commands, manages Tauri state
            (GraphState, NoRestore flag), and configures plugins.

    data_flow:
        1. User selects a folder or clones a repo URL.
        2. Frontend calls scan_repo -> cc-tauri -> RepoScanner -> CodeGraph (skeleton).
        3. Graph stored in server-side GraphState.
        4. Frontend calls parse_repo -> cc-tauri takes graph from state, parses files
           in parallel with rayon, resolves references via SymbolTable, stores updated
           graph back in state, returns full graph.
        5. Frontend receives graph, computes ELK layout, renders with Pixi.js.
        6. get_subgraph reads graph from state for filtered views.

Features Index:
    server_side_graph_state:
        description: Backend keeps the CodeGraph in managed Tauri state instead of
                     requiring the frontend to pass the full graph JSON on every IPC call.
        entry_points: [src-tauri/src/lib.rs, crates/cc-tauri/src/lib.rs]
        depends_on: []
        doc: docs/features/server_side_graph_state.md

    edge_dedup:
        description: O(1) edge deduplication using a HashMap index keyed by
                     (source, target, kind). Duplicate edges increment weight instead
                     of creating new entries.
        entry_points: [crates/cc-core/src/model/graph.rs]
        depends_on: []
        doc: docs/features/edge_dedup.md

    parallel_parsing:
        description: File parsing is parallelized using rayon. Each file is read and
                     parsed with Tree-sitter in parallel, then results are merged
                     sequentially into the graph.
        entry_points: [crates/cc-tauri/src/commands/parse.rs]
        depends_on: [edge_dedup]
        doc: docs/features/parallel_parsing.md
