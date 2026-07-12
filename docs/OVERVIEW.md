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
        2. Frontend calls scan_repo (Tauri IPC) -> cc-tauri scans directory tree -> stores the graph in server-side GraphState and returns an edge-less ParseResult with Directory/File nodes.
        3. Frontend calls parse_repo (Tauri IPC) -> cc-tauri first strips any prior parse state so re-parsing is idempotent -> parses each file with tree-sitter (parallel via rayon) in a single tree walk that attributes each raw reference to its innermost enclosing block (top-level imports/refs attributed to the File) and populates each block's children hierarchy -> only top-level blocks are appended to File children -> resolves imports first (yielding file-to-file Import edges plus an import map), then resolves references into edges via SymbolTable using a precision ladder (same-file > imported-file > global-unique > ambiguous, dropping references matching more than 5 global symbols) so each edge carries a Resolution confidence -> keeps the full graph (nodes + edges, with adjacency rebuilt) in server-side GraphState and returns an edge-less ParseResult (nodes, root, edge_count, node_edge_kinds connectivity map).
        4. Frontend graphStore converts the ParseResult into a CodeGraph (node tree + nodeEdgeKinds Map, no edges) and computes visibility/expansion state. The hideUnconnectedNodes filter (visibilityFilter) runs synchronously from nodeEdgeKinds.
        5. Canvas component passes the (edge-less) graph + state to PixiRenderer.
        6. PixiRenderer delegates to elkLayout: build the ELK node tree, collect the render set (elkNodeIds), fetch per-view direct + aggregated edges via get_subgraph(render_ids, edge_kinds) computed server-side (direct edges carry a Resolution; ambiguous edges may be hidden client-side), then render nodes and edges on the Pixi.js canvas. Views over 1500 rendered nodes skip ELK edge routing and use straight-line fallback edges.
        7. User interactions (hover, select, expand, drag, zoom) update stores and trigger re-renders. Edge tooltips read kind + count from the layout edges (aggregated edges carry a collapsed count).

Features Index:
    canvas-rendering:
        description: Interactive Pixi.js canvas with node rendering, edge drawing, minimap, drag, and LOD-based visibility.
        entry_points: [packages/app/src/canvas/renderers/PixiRenderer.ts, packages/app/src/canvas/Canvas.tsx]
        depends_on: [graph-layout]
        doc: docs/features/canvas-rendering.md

    graph-layout:
        description: ELK-based hierarchical graph layout. Fetches per-view direct + aggregated edges from the backend (get_subgraph) rather than filtering client-side, feeds them to ELK for routing, and falls back to straight-line edges (also used as the layout guard for views over 1500 rendered nodes).
        entry_points: [packages/app/src/canvas/layout/elkLayout.ts]
        depends_on: [graph-model]
        doc: docs/features/graph-layout.md

    graph-model:
        description: Rust data model for code graphs including nodes (Directory, File, CodeBlock), edges with kinds, adjacency indexes, EdgeIndex for O(1) dedup, ParseResult (edge-less IPC payload with per-node connectivity map), and SubGraph extraction that computes direct + aggregated (collapsed-container) view edges server-side.
        entry_points: [crates/cc-core/src/model/graph.rs, crates/cc-core/src/model/edge.rs, crates/cc-core/src/model/edge_index.rs]
        depends_on: []
        doc: docs/features/server_side_graph_state.md

    parsing:
        description: Tree-sitter based source code parsing using a trait-based LanguageSupport system. Extracts code blocks and raw references from Python, TypeScript, JavaScript, and Rust files. Includes extension probing for import resolution.
        entry_points: [crates/cc-core/src/parser/extract.rs, crates/cc-core/src/parser/language.rs, crates/cc-tauri/src/commands/parse.rs]
        depends_on: [graph-model]
        doc: docs/features/parsing.md

    resolution_precision:
        description: Precision ladder that resolves each raw reference to the highest-confidence target (same-file > imported-file > single global match > up to 5 ambiguous candidates; more than 5 dropped). Every edge carries a Resolution; ambiguous edges are rendered dashed/dimmed and can be hidden via a toolbar toggle.
        entry_points: [crates/cc-core/src/resolver/symbol_table.rs, crates/cc-core/src/resolver/import_resolver.rs, crates/cc-tauri/src/commands/parse.rs]
        depends_on: [parsing, graph-model]
        doc: docs/features/resolution_precision.md

    state-management:
        description: Zustand stores for graph state, viewport state, debug logging, and persistence.
        entry_points: [packages/app/src/stores/graphStore.ts, packages/app/src/stores/viewportStore.ts, packages/app/src/stores/debugStore.ts]
        depends_on: []

    sidebar:
        description: File/symbol tree sidebar with search, checkbox visibility toggles, and expansion controls.
        entry_points: [packages/app/src/sidebar/Sidebar.tsx, packages/app/src/sidebar/searchUtils.ts]
        depends_on: [state-management]
        doc: docs/features/sidebar.md

    toolbar:
        description: Top toolbar with folder open, GitHub clone, edge kind toggles, and LOD settings panel.
        entry_points: [packages/app/src/toolbar/Toolbar.tsx, packages/app/src/toolbar/EdgeToggleButton.tsx, packages/app/src/toolbar/LODSettingsPanel.tsx]
        depends_on: [state-management]
        doc: docs/features/toolbar.md

    error-handling:
        description: React ErrorBoundary components wrapping major UI sections for graceful error recovery.
        entry_points: [packages/app/src/components/ErrorBoundary.tsx, packages/app/src/App.tsx]
        depends_on: []
        doc: docs/features/error-handling.md
