Overview:
    description:
        CodeCartographer is a desktop application for visualizing code structure and dependencies
        as an interactive graph. It parses source code using Tree-sitter, builds a typed graph of
        directories, files, and code blocks (functions, classes, structs, etc.), resolves references
        between them (imports, calls, type usage, inheritance), and renders the result as an
        interactive hierarchical visualization using WebGL.

        Supported languages: Python, TypeScript, JavaScript, Rust.

        Technology stack: Tauri 2 (desktop), Rust (backend), React 19 + TypeScript (frontend),
        Tree-sitter (parsing), Pixi.js (WebGL rendering), ELK.js (graph layout), Zustand (state).

    subsystems:
        cc-core (crates/cc-core):
            The core engine. Contains the data model (nodes, edges, graphs), the Tree-sitter-based
            parser/extractor, the repository scanner, and the reference resolution pipeline
            (imports, calls, types). This is a pure Rust library with no Tauri dependency.

        cc-tauri (crates/cc-tauri):
            The IPC bridge. Exposes cc-core functionality as Tauri commands that the frontend can
            invoke over JSON serialization. Commands: scan_repo, parse_repo, get_subgraph,
            clone_github_repo. Handles streaming parse progress events via Tauri Channels.

        tauri-app (src-tauri):
            The Tauri application shell. Configures the window, registers plugins (dialog),
            wires up commands from cc-tauri, and initializes tracing. Minimal glue code.

        frontend (packages/app):
            The React/TypeScript UI. Contains the canvas rendering engine (Pixi.js + ELK.js),
            the sidebar tree view, the toolbar controls, Zustand state stores, and the Tauri
            IPC wrapper layer. Manages graph visualization, user interaction, and state persistence.

    data_flow:
        1. User selects a local folder or clones a repo URL via the Toolbar.
        2. Frontend calls scan_repo → cc-tauri → RepoScanner::scan() → returns CodeGraph skeleton
           (Directory and File nodes, no edges).
        3. Frontend calls parse_repo with the skeleton graph. cc-tauri iterates files, calling
           Extractor::extract_file() via Tree-sitter for each one. Streams FileStart/FileDone/Error
           events to the frontend via a Tauri Channel.
        4. After all files are parsed, cc-tauri builds a SymbolTable from the graph and resolves
           all raw references into typed CodeEdges (Import, FunctionCall, MethodCall, TypeReference,
           Inheritance, TraitImpl, VariableUsage). Sends Complete event and returns the full graph.
        5. Frontend receives the full CodeGraph, passes visible nodes to ELK.js for hierarchical
           layout computation, then renders the positioned nodes and edges on the Pixi.js WebGL canvas.
        6. User interactions (expand/collapse, visibility toggle, edge filtering, zoom/pan, selection)
           update Zustand stores, trigger relayout or re-render as needed, and optionally call
           get_subgraph for filtered views.
        7. UI state (expanded/visible nodes) is persisted to localStorage per folder.

Features Index:
    code-parsing:
        description: Tree-sitter based extraction of code blocks and raw references from Python, TypeScript, JavaScript, and Rust source files.
        entry_points: [crates/cc-core/src/parser/extract.rs]
        depends_on: [data-model]
        doc: docs/features/cc-core.md

    data-model:
        description: Typed graph model with Directory/File/CodeBlock nodes, 7 edge kinds, adjacency indexes, and SubGraph filtering.
        entry_points: [crates/cc-core/src/model/graph.rs, crates/cc-core/src/model/node.rs, crates/cc-core/src/model/edge.rs]
        depends_on: []
        doc: docs/features/cc-core.md

    reference-resolution:
        description: Symbol table construction and resolution of imports, function/method calls, type references, inheritance, and trait implementations into typed edges.
        entry_points: [crates/cc-core/src/resolver/symbol_table.rs]
        depends_on: [code-parsing, data-model]
        doc: docs/features/cc-core.md

    repo-scanning:
        description: Gitignore-aware directory walking to discover files and build the initial graph skeleton, plus GitHub/GitLab shallow cloning.
        entry_points: [crates/cc-core/src/repo/scanner.rs, crates/cc-core/src/repo/clone.rs]
        depends_on: [data-model]
        doc: docs/features/cc-core.md

    tauri-commands:
        description: IPC bridge exposing scan_repo, parse_repo, get_subgraph, and clone_github_repo as Tauri commands with JSON serialization and streaming events.
        entry_points: [crates/cc-tauri/src/commands/mod.rs]
        depends_on: [code-parsing, reference-resolution, repo-scanning]
        doc: docs/features/cc-tauri.md

    graph-visualization:
        description: Interactive WebGL rendering of the code graph using Pixi.js with hierarchical ELK.js layout, LOD culling, edge filtering, and node interaction.
        entry_points: [packages/app/src/canvas/Canvas.tsx, packages/app/src/canvas/renderers/PixiRenderer.ts]
        depends_on: [tauri-commands, state-management]
        doc: docs/features/frontend.md

    state-management:
        description: Zustand stores managing graph state, viewport/LOD, debug info, and localStorage persistence of UI state per folder.
        entry_points: [packages/app/src/stores/graphStore.ts, packages/app/src/stores/viewportStore.ts, packages/app/src/stores/persistenceStore.ts]
        depends_on: []
        doc: docs/features/frontend.md

    ui-controls:
        description: Toolbar (folder open, clone, edge filters, LOD) and Sidebar (tree view, search, visibility toggles, parse progress) React components.
        entry_points: [packages/app/src/toolbar/Toolbar.tsx, packages/app/src/sidebar/Sidebar.tsx]
        depends_on: [state-management, tauri-commands]
        doc: docs/features/frontend.md

    desktop-app:
        description: Tauri 2 application shell with window configuration, plugin registration, command wiring, and build pipeline.
        entry_points: [src-tauri/src/main.rs, src-tauri/src/lib.rs]
        depends_on: [tauri-commands]
        doc: docs/features/tauri-app.md

    benchmarking:
        description: Criterion benchmark suite measuring graph operations (add_edge, rebuild_adjacency, subgraph extraction) and parsing pipeline performance across languages.
        entry_points: [crates/cc-core/benches/graph_bench.rs, crates/cc-core/benches/parse_bench.rs]
        depends_on: [data-model, code-parsing, reference-resolution]
        doc: docs/features/benchmarking.md
