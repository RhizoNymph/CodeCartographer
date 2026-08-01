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
        2. Frontend calls scan_repo (Tauri IPC) -> cc-tauri scans directory tree (respecting .gitignore plus explicit directory ignore rules for virtualenvs/caches/build output, and mapping .py/.pyi to Python) -> stores the graph in server-side GraphState and returns an edge-less ParseResult with Directory/File nodes.
        3. Frontend calls parse_repo (Tauri IPC) -> cc-tauri first strips any prior parse state so re-parsing is idempotent -> parses each file with tree-sitter (parallel via rayon) in a single tree walk that attributes each raw reference to its innermost enclosing block (top-level imports/refs attributed to the File) and populates each block's children hierarchy -> only top-level blocks are appended to File children -> resolves imports first (yielding file-to-file Import edges plus an import map), then resolves references into edges via SymbolTable using a precision ladder (same-file > imported-file > global-unique > ambiguous, dropping references matching more than 5 global symbols) so each edge carries a Resolution confidence -> keeps the full graph (nodes + edges, with adjacency rebuilt) in server-side GraphState and returns an edge-less ParseResult (nodes, root, edge_count, node_edge_kinds connectivity map).
        4. Frontend graphStore converts the ParseResult into a CodeGraph (node tree + nodeEdgeKinds Map, no edges) and computes visibility/expansion state. The hideUnconnectedNodes filter (visibilityFilter) runs synchronously from nodeEdgeKinds.
        5. Canvas derives the effective layout inputs from the zoom-level viewMode (default "module"): module view forces edge kinds to {Import} and treats files as collapsed (saved state preserved but ignored); symbol view uses the user's edge kinds + expansion; a focus neighborhood, when active, restricts visibility/expansion to the fetched neighborhood ids. Canvas passes the (edge-less) graph + effective state to PixiRenderer.
        6. PixiRenderer delegates to elkLayout: build the ELK node tree, collect the render set (elkNodeIds), fetch per-view direct + aggregated edges via get_subgraph(render_ids, edge_kinds) computed server-side (direct edges carry a Resolution; ambiguous edges may be hidden client-side), then render nodes and edges on the Pixi.js canvas. Views over 1500 rendered nodes skip ELK edge routing and use straight-line fallback edges.
        7. The layout pass also derives per-kind edge counts for the view from that same SubGraph payload; PixiRenderer publishes them to edgeLegendStore once the layout is known to be current, and the bottom-left EdgeLegend overlay renders one row per edge kind (colour, name, count) which doubles as the edge-kind toggle UI.
        8. User interactions (hover, select, expand, drag, zoom) update stores and trigger re-renders. Edge tooltips read kind + count from the layout edges (aggregated edges carry a collapsed count). Aggregated edges (count > 1) additionally render a world-space "×N" chip at the arc-length midpoint of their routed polyline, at the "detail" LOD only.
        9. Focus / drill-down: the user focuses a node (F hotkey on the hovered/selected node, the canvas selection chip or Sidebar row Focus button, or a module-view File double-click) -> get_neighborhood(node_id, depth, edge_kinds, direction) runs a depth-bounded BFS in cc-core (both directions, callers only, or callees only) and returns the neighborhood node ids (incl. container chain) + direct edges -> the store switches to symbol view and the canvas lays out ONLY that neighborhood. Focus is a STACK: focusing again from inside a focused view pushes a deeper frame, each frame carrying its own depth + direction. A breadcrumb trail (root "All" chip + one chip per frame, current frame carrying the depth selector and callers|both|callees toggle) navigates back; clicking a chip pops to that frame, X clears the stack, Esc pops one frame.

Features Index:
    canvas-rendering:
        description: Interactive Pixi.js canvas with node rendering, edge drawing, minimap, drag, and LOD-based visibility. Aggregated (collapsed-container) edges carry "xN" count chips drawn at the arc-length midpoint of their routed polyline, shown at the "detail" LOD only and dimmed in step with the edge they label.
        entry_points: [packages/app/src/canvas/renderers/PixiRenderer.ts, packages/app/src/canvas/Canvas.tsx, packages/app/src/canvas/renderers/edgeLabels.ts]
        depends_on: [graph-layout, palette]
        doc: docs/features/canvas-rendering.md

    palette:
        description: >
            The graph's colour vocabulary, built so a colour identifies exactly one category.
            Five edge hues cover seven edge kinds -- FunctionCall/MethodCall share one "calls" hue and
            Inheritance/TraitImpl share one "subtype relation" hue, while the kinds stay distinct in the
            model, tooltips, toggles and EDGE_STYLES. Edges own the saturated end of the spectrum and
            blocks/nodes the muted end; no hex (and no near-duplicate hex) is shared across EDGE_COLORS,
            BLOCK_COLORS and NODE_COLORS, and every edge hue clears WCAG 3:1 against the dark canvas and
            every node fill it can cross. Colour is frontend-only -- cc-core's EdgeKind carries none.
        entry_points: [packages/app/src/api/types.ts, packages/app/src/canvas/renderers/types.ts]
        depends_on: []
        doc: docs/features/palette.md

    graph-layout:
        description: ELK-based hierarchical graph layout running in a web worker (elk-api + elk-worker.min.js?worker) so layout does not block the UI thread. Fetches per-view direct + aggregated edges from the backend (get_subgraph) rather than filtering client-side, feeds them to ELK for routing, and falls back to straight-line edges (also used as the layout guard for views over 1500 rendered nodes).
        entry_points: [packages/app/src/canvas/layout/elkLayout.ts]
        depends_on: [graph-model]
        doc: docs/features/graph-layout.md

    graph-model:
        description: Rust data model for code graphs including nodes (Directory, File, CodeBlock), edges with kinds, adjacency indexes, EdgeIndex for O(1) dedup, ParseResult (edge-less IPC payload with per-node connectivity map), SubGraph extraction that computes direct + aggregated (collapsed-container) view edges server-side, and a directional Neighborhood BFS query (FocusDirection both/upstream/downstream applied at every hop, depth-bounded, with container chain) backing focus mode.
        entry_points: [crates/cc-core/src/model/graph.rs, crates/cc-core/src/model/edge.rs, crates/cc-core/src/model/edge_index.rs]
        depends_on: []
        doc: docs/features/server_side_graph_state.md

    parsing:
        description: Tree-sitter based source code parsing using a trait-based LanguageSupport system. Extracts code blocks and raw references from Python, TypeScript, JavaScript, and Rust files. Includes extension probing for import resolution. Python extraction additionally emits clean dotted Import module paths (multi-name and aliased imports handled, alias clauses and imported symbol names excluded), edge-free ImportedSymbol bindings recording what each `from x import y as z` name denotes, module-level Constant/TypeAlias blocks (module body + single-identifier target only, so class fields and function locals never become nodes) plus PEP 695 `type X = Y` TypeAlias blocks (their declaration side never self-references), leaf-only type annotation refs including PEP 484 string forward references (builtins and typing constructs filtered; Literal/Annotated string *values* excluded), attribute/subscript/keyword-argument class bases, bare decorator refs, distinct SelfMethodCall refs for `self.x()`/`cls.x()` receivers, and dunder-aware visibility.
        entry_points: [crates/cc-core/src/parser/extract.rs, crates/cc-core/src/parser/language.rs, crates/cc-tauri/src/commands/parse.rs]
        depends_on: [graph-model]
        doc: docs/features/parsing.md

    resolution_precision:
        description: Precision ladder that resolves each raw reference to the highest-confidence target (a `self.x()` member of the enclosing class > same-file > the module named by an explicit `from x import y` binding > any imported file > single global match > up to 5 ambiguous candidates; more than 5 dropped). The binding tier reads edge-free ImportedSymbol refs, so it pins the exact defining module and carries an `as` rename back to the original symbol name without changing edge volume. Every edge carries a Resolution; ambiguous edges are rendered dashed/dimmed and can be hidden via a toolbar toggle. Import resolution covers Python relative imports, Python absolute imports resolved against detected package roots (repo root, src/ dirs, package-chain parents -- nearest the importing file first, so src layouts and monorepo packages/*/ layouts work), Rust use paths, and TS/JS relative paths. All path lookups go through a PathIndex holding full file paths only, so an extension-less module path (./util, mypkg.util, crate::util) is answered by extension probing scoped to the importing file's language -- util.py, util.ts and util.rs never shadow each other in polyglot repos, and Python .pyi stubs always rank behind the real module.
        entry_points: [crates/cc-core/src/resolver/symbol_table.rs, crates/cc-core/src/resolver/import_resolver.rs, crates/cc-core/src/resolver/path_index.rs, crates/cc-core/src/resolver/python_roots.rs, crates/cc-tauri/src/commands/parse.rs]
        depends_on: [parsing, graph-model, repo-scanning]
        doc: docs/features/resolution_precision.md

    repo-scanning:
        description: Directory-tree walk producing Directory/File nodes. Respects .gitignore/.git/exclude and hidden files, and additionally applies explicit directory ignore rules (DirIgnoreRule) so Python virtualenvs, __pycache__, site-packages, .tox/.nox/.mypy_cache/.pytest_cache/.ruff_cache and *.egg-info are never scanned; build/ and dist/ are skipped only when they are not Python packages. File language is derived from the extension (.py/.pyi -> Python, .ts/.tsx, .js/.jsx, .rs).
        entry_points: [crates/cc-core/src/repo/scanner.rs, crates/cc-core/src/model/node.rs]
        depends_on: [graph-model]

    zoom-views:
        description: Two zoom-level views selected by a toolbar segmented control. Module view (default on load) is the trustworthy zoomed-out import graph -- files render collapsed and only Import edges show, as DERIVED constraints over the user's saved state (never mutating it). Symbol view is the detailed expandable view with all enabled edge kinds. Focus mode drills into a bounded neighborhood of a node (cc-core Neighborhood BFS via get_neighborhood) so the full symbol graph is never laid out; entered via the F hotkey (hovered node, falling back to the selected one), the canvas selection chip or Sidebar row Focus button, or a module-view File double-click. Focus is a stack of frames (FocusFrame: node frames carry a 1/2-hop depth + a both/upstream/downstream trace direction; an edge variant is reserved for edge drill-in) -- focusing from inside focus pushes deeper, the breadcrumb trail pops back, X clears the stack, and Esc pops exactly one frame. Focus actions are never placed in the hover tooltip, which unmounts on pointerout before it can be clicked. viewMode persists per folder; the focus stack is transient and cleared by module view.
        entry_points: [packages/app/src/stores/graphViewModel.ts, packages/app/src/stores/graphStore.ts, packages/app/src/canvas/Canvas.tsx, packages/app/src/canvas/FocusBreadcrumb.tsx, packages/app/src/canvas/SelectionChip.tsx, packages/app/src/canvas/focusHotkey.ts, packages/app/src/canvas/useEscapeKey.ts, crates/cc-core/src/model/graph.rs, crates/cc-tauri/src/commands/parse.rs]
        depends_on: [state-management, graph-layout, graph-model, resolution_precision]
        doc: docs/features/zoom_views.md

    state-management:
        description: Zustand stores for graph state (incl. viewMode, the focus stack and the top frame's neighborhood), viewport state, per-view edge-kind counts published by the layout pass (edgeLegendStore), debug logging, and per-folder persistence (expanded/visible/viewMode). Pure view derivation + focus reducers live in graphViewModel.ts.
        entry_points: [packages/app/src/stores/graphStore.ts, packages/app/src/stores/graphViewModel.ts, packages/app/src/stores/viewportStore.ts, packages/app/src/stores/edgeLegendStore.ts, packages/app/src/stores/debugStore.ts]
        depends_on: []

    sidebar:
        description: File/symbol tree sidebar with search, checkbox visibility toggles, and expansion controls.
        entry_points: [packages/app/src/sidebar/Sidebar.tsx, packages/app/src/sidebar/searchUtils.ts]
        depends_on: [state-management]
        doc: docs/features/sidebar.md

    toolbar:
        description: Top toolbar with folder open, GitHub clone, a Module|Symbol view-mode segmented control, the hide-unconnected/hide-ambiguous checkboxes, and the LOD settings panel (all but the view-mode control hidden in module view). Edge-kind toggling has moved to the canvas edge-legend overlay.
        entry_points: [packages/app/src/toolbar/Toolbar.tsx, packages/app/src/toolbar/LODSettingsPanel.tsx]
        depends_on: [state-management]
        doc: docs/features/toolbar.md

    edge-legend:
        description: Bottom-left canvas overlay that is also the edge-kind toggle UI. One row per edge kind available in the view (colour swatch, human-readable name, and the count of underlying edges of that kind IN THE CURRENT VIEW -- direct edges count 1, aggregated edges contribute their collapsed count). Counts are derived from the SubGraph the layout pass already fetched and published to edgeLegendStore after the renderer's stale-layout check. Clicking a row toggles the kind; toggled-off rows are dimmed/struck but stay clickable, enabled kinds with zero edges are dimmed and inert, and module view shows only a non-interactive Import row.
        entry_points: [packages/app/src/canvas/legend/EdgeLegend.tsx, packages/app/src/canvas/legend/edgeLegendModel.ts, packages/app/src/stores/edgeLegendStore.ts]
        depends_on: [graph-layout, state-management, zoom-views]
        doc: docs/features/edge-legend.md

    error-handling:
        description: React ErrorBoundary components wrapping major UI sections for graceful error recovery.
        entry_points: [packages/app/src/components/ErrorBoundary.tsx, packages/app/src/App.tsx]
        depends_on: []
        doc: docs/features/error-handling.md
