Overview:
    description:
        CodeCartographer is a Tauri desktop application (Rust backend + React/TypeScript frontend)
        for visualizing code structure as interactive graphs. It scans a repository, parses source
        files using tree-sitter, resolves references between code symbols, and renders the resulting
        graph as an interactive canvas using Pixi.js with ELK layout.

    subsystems:
        - cc-core (Rust): Core library containing the graph model (CodeGraph, CodeNode, CodeEdge),
          file scanner, tree-sitter parser/extractor, and symbol resolver. Language-agnostic graph
          operations and data structures.
        - cc-tauri (Rust): Tauri command layer exposing parse_repo, get_subgraph, and scan_repo
          commands over IPC. Orchestrates cc-core operations and sends progress events.
        - packages/app (TypeScript/React): Frontend application with Pixi.js canvas rendering,
          ELK graph layout, Zustand state stores, and toolbar UI.

    data_flow:
        1. User selects a repository path via the toolbar.
        2. Frontend calls scan_repo (Tauri IPC) -> cc-tauri scans directory tree -> returns CodeGraph with Directory/File nodes.
        3. Frontend calls parse_repo (Tauri IPC) -> cc-tauri parses each file with tree-sitter (parallel via rayon) -> extracts CodeBlock nodes and raw references -> resolves references into edges via SymbolTable -> returns enriched CodeGraph.
        4. Frontend graphStore receives the CodeGraph, computes visibility/expansion state.
        5. Canvas component passes graph + state to PixiRenderer.
        6. PixiRenderer delegates to elkLayout for node positioning, then renders nodes and edges on the Pixi.js canvas.
        7. User interactions (hover, select, expand, drag, zoom) update stores and trigger re-renders.

Features Index:
    canvas-rendering:
        description: Interactive Pixi.js canvas with node rendering, edge drawing, minimap, drag, and LOD-based visibility.
        entry_points: [packages/app/src/canvas/renderers/PixiRenderer.ts, packages/app/src/canvas/Canvas.tsx]
        depends_on: [graph-layout]
        doc: docs/features/canvas-rendering.md

    graph-layout:
        description: ELK-based hierarchical graph layout with edge routing, aggregated edges for collapsed containers, and fallback layout.
        entry_points: [packages/app/src/canvas/layout/elkLayout.ts]
        depends_on: []
        doc: docs/features/graph-layout.md

    graph-model:
        description: Rust data model for code graphs including nodes (Directory, File, CodeBlock), edges with kinds, adjacency indexes, EdgeIndex for O(1) dedup, and subgraph extraction.
        entry_points: [crates/cc-core/src/model/graph.rs, crates/cc-core/src/model/edge.rs, crates/cc-core/src/model/edge_index.rs]
        depends_on: []
        doc: docs/features/edge_dedup.md

    parsing:
        description: Tree-sitter based source code parsing with parallel file extraction via rayon, structured error types, and debug-gated diagnostic logging. Extracts code blocks and raw references from Python, TypeScript, JavaScript, and Rust files.
        entry_points: [crates/cc-core/src/parser/extract.rs, crates/cc-tauri/src/commands/parse.rs]
        depends_on: [graph-model]
        doc: docs/features/parallel_parsing.md

    state-management:
        description: Zustand stores for graph state, viewport state, debug logging, and persistence.
        entry_points: [packages/app/src/stores/graphStore.ts, packages/app/src/stores/viewportStore.ts, packages/app/src/stores/debugStore.ts]
        depends_on: []
