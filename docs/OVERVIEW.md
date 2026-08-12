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
        - cc-tauri (Rust): Tauri command layer exposing scan_repo, parse_repo, get_subgraph,
          get_neighborhood, get_edge_detail and get_node_details commands over IPC. Orchestrates
          cc-core operations and sends batched progress events. The graph lives in an
          RwLock<Option<Arc<CodeGraph>>>; readers clone the Arc under a brief read lock and run
          their CPU work on the blocking pool, so queries never serialize behind each other.
        - packages/app (TypeScript/React): Frontend application with Pixi.js canvas rendering,
          ELK graph layout, Zustand state stores, and toolbar UI.

    data_flow:
        1. User selects a repository path via the toolbar.
        2. Frontend calls scan_repo (Tauri IPC) -> cc-tauri scans directory tree (respecting .gitignore plus explicit directory ignore rules for virtualenvs/caches/build output, and mapping .py/.pyi to Python) -> installs the graph in server-side GraphState behind an Arc (RwLock) and returns an edge-less ParseResult with Directory/File nodes that BORROWS that same graph, so no node map is copied for the response.
        3. Frontend calls parse_repo (Tauri IPC) -> cc-tauri first strips any prior parse state so re-parsing is idempotent -> parses each file with tree-sitter (parallel via rayon) in a single tree walk that attributes each raw reference to its innermost enclosing block (top-level imports/refs attributed to the File) and populates each block's children hierarchy -> only top-level blocks are appended to File children, with progress reported as ONE batched ParseEvent::Progress per ~100 files or ~50ms (cumulative counts + last file + that batch's per-file errors) instead of two events per file -> resolves imports first (yielding file-to-file Import edges plus an import map), then resolves references into edges via SymbolTable using a precision ladder (same-file > imported-file > global-unique > ambiguous, dropping references matching more than 5 global symbols — abandoned before the candidates are even cloned) so each edge carries a Resolution confidence -> keeps the full graph (nodes + edges, with adjacency rebuilt) in server-side GraphState and returns an edge-less ParseResult (nodes, root, edge_count, node_edge_kinds connectivity map) serialized straight out of the stored graph. Nodes go over the wire SLIM: every field except `signature`, which only the details panel and hover tooltip read and which they fetch per node via get_node_details.
        4. Frontend graphStore converts the ParseResult into a CodeGraph (node tree + nodeEdgeKinds Map, no edges, no signatures) and computes visibility/expansion state. The hideUnconnectedNodes filter (visibilityFilter) runs synchronously from nodeEdgeKinds. handleParseEvent applies one store update per progress batch, so ingestion no longer broadcasts once per file.
        5. Canvas derives the effective layout inputs from the zoom-level viewMode (default "module"): module view forces edge kinds to {Import} and treats files as collapsed (saved state preserved but ignored); symbol view uses the user's edge kinds + expansion; an active focus frame restricts visibility/expansion to the fetched focus ids (a node frame's neighborhood or an edge frame's edge detail). Canvas passes the (edge-less) graph + effective state to PixiRenderer.
        6. The layout pipeline has two phases behind one coalescing queue in PixiRenderer, and the store's relayoutPolicy decides which one a given state change needs (full / edges / visibility / nothing -- at most ONE per user action):
           - Positions phase (full): elkLayout builds the ELK node tree, collects the render set (renderIds), fetches per-view direct + aggregated edges via get_subgraph(render_ids, edge_kinds) computed server-side (direct edges carry a Resolution; ambiguous edges may be hidden client-side), then ELK places the nodes and routes the edges and the renderer rebuilds the canvas. Views over 1500 rendered nodes OR over 3000 view edges skip ELK edge routing and use straight-line fallback edges. Triggered by a new graph, expand/collapse, showing nodes, hide-unconnected, view-mode switches, focus changes, and the sidebar's explicit "Apply Layout Changes" button (graphStore.layoutVersion).
           - Edges phase (cheap): edge-kind and hide-ambiguous toggles re-run only get_subgraph for the SAME render set and rebuild the edges on the cached node positions -- reusing each surviving edge's routed polyline and straight-lining edges that appear anew -- with no ELK run and no camera move (graphStore.edgeVersion). Hiding nodes is cheaper still: the canvas just flips the existing node displays.
           While a pass is in flight, further requests collapse into ONE pending rerun with the latest inputs (elkjs cannot be aborted), and stale results are discarded by _layoutRequestId. At draw time the client re-routing pass (obstacle avoidance) is separately budgeted: node boxes are indexed once per redraw in an R-tree and each edge queries only the obstacles near it, candidate crossing-scoring is dropped above 250 rendered edges, and re-routing is skipped entirely above 500 rendered edges or 2000 visible nodes -- so edge redraw time stays bounded instead of growing without limit. Applying a layout performs exactly ONE full edge rebuild.
        7. Both phases derive per-kind edge counts for the view from that same SubGraph payload; PixiRenderer publishes them to edgeLegendStore once the pass is known to be current, and the bottom-left EdgeLegend overlay renders one row per edge kind (colour, name, count) which doubles as the edge-kind toggle UI.
        8. User interactions (hover, select, expand, drag, zoom) update stores and trigger re-renders. Selection is a node SET (`selectedNodeIds`, with `selectedNodeId` as the derived last-selected primary) and doubles as the pinned edge highlight: hovering previews a node's connections, clicking pins that same dim+highlight treatment so it survives unhover, and ctrl/cmd-clicking a second node switches the highlight to the induced subgraph (only edges with both endpoints selected). The pin is re-applied after every base-layer rebuild and invalidated when its nodes leave the graph. Hovering an EDGE additionally emphasises its two endpoint nodes' borders. Edge tooltips read kind + count from the layout edges (aggregated edges carry a collapsed count). Aggregated edges (count > 1) additionally render a world-space "×N" chip at the arc-length midpoint of their routed polyline, at the "detail" LOD only.
        9. Selecting a node also drives the right-side details panel: it fetches get_neighborhood(selectedNodeId, 1, ALL kinds) (debounced, with a monotonic stale-request guard), splits those edges into incoming/outgoing around the selected node, groups them per kind, and renders clickable endpoint rows with per-row Focus buttons.
        10. Focus / drill-down. Focus is a STACK of FocusFrames, each held next to its fetched payload; focusing again from inside a focused view pushes a deeper frame, and the canvas lays out ONLY the top frame's ids:
           - Node focus: the user focuses a node (F hotkey on the hovered/selected node, the canvas selection chip, Sidebar row or details-panel Focus buttons, or a module-view File double-click) -> get_neighborhood(node_id, depth, edge_kinds, direction) runs a depth-bounded BFS in cc-core (both directions, callers only, or callees only -- direction applied at every hop) and returns the neighborhood node ids (incl. container chain) + direct edges. Depth and direction are per-frame.
           - Edge focus: the user double-clicks an AGGREGATED edge (count > 1) -> get_edge_detail(source_id, target_id, edge_kinds) runs cc-core's edge_detail, re-expanding that one aggregate into the underlying edges running from the source subtree into the target subtree (that direction only), plus their endpoints and container chain. Edge frames have no depth/direction.
           Either way the store switches to symbol view. A breadcrumb trail (root "All" chip + one chip per frame -- node name or "source -> target" -- with the current frame carrying the 1/2-hop depth selector and callers|both|callees toggle for node frames) navigates back: clicking a chip pops to that frame, X clears the stack, Esc pops exactly one frame -- and Esc only reaches the focus layer once the node selection is empty (see selection.md).

Features Index:
    canvas-rendering:
        description: Interactive Pixi.js canvas with node rendering, edge drawing, minimap, drag, and LOD-based visibility. Applying a layout performs exactly one full edge rebuild, and the edge re-routing pass is bounded by an R-tree obstacle index plus a routing budget (full > obstacles-only > none) chosen from the rendered-edge and visible-node counts. Edges are hit-tested by distance to their routed polyline, which drives edge hover, double-click-to-drill-in on aggregated edges, and a border emphasis on the hovered edge's two endpoint nodes (so it is visible where an edge lands without tracing it by eye). Node borders come from one emphasis table (selected > hovered-edge endpoint > plain). Aggregated (collapsed-container) edges carry "xN" count chips drawn at the arc-length midpoint of their routed polyline, shown at the "detail" LOD only and dimmed in step with the edge they label.
        entry_points: [packages/app/src/canvas/renderers/PixiRenderer.ts, packages/app/src/canvas/Canvas.tsx, packages/app/src/canvas/renderers/edgeDrawing.ts, packages/app/src/canvas/renderers/edgeRoutingBudget.ts, packages/app/src/canvas/layout/obstacleIndex.ts, packages/app/src/canvas/renderers/edgeLabels.ts, packages/app/src/canvas/renderers/nodeEmphasis.ts]
        depends_on: [graph-layout, palette]
        doc: docs/features/canvas-rendering.md

    selection:
        description: >
            The selected node set is the source of truth for both selection and the pinned edge
            highlight (they are the same concept -- there is no separate "pinned node" field).
            Plain click replaces, ctrl/cmd-click toggles, empty-canvas click / chip Clear / Esc
            clears. Highlight precedence is hover > pinned selection > none; 2+ selected nodes
            highlight the INDUCED subgraph (both endpoints selected) instead of all connections.
            Esc is consumed by the selection layer first (capture-phase listener) and only falls
            through to focus handling when nothing is selected. All decisions live in the
            dependency-free pure module selectionModel.ts.
        entry_points: [packages/app/src/stores/selectionModel.ts, packages/app/src/stores/graphStore.ts, packages/app/src/canvas/useSelectionEscape.ts, packages/app/src/canvas/SelectionChip.tsx]
        depends_on: [state-management, canvas-rendering]
        doc: docs/features/selection.md

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
        description: ELK-based hierarchical graph layout running in a web worker (elk-api + elk-worker.min.js?worker) so layout does not block the UI thread, split into a POSITIONS phase (ELK) and an EDGES phase (get_subgraph fetch + edge rebuild against cached positions) behind a run-latest coalescing queue. A dependency-free trigger policy (relayoutPolicy) classifies every state change as full / edges / visibility / nothing, so one user action costs at most one layout pass. Fetches per-view direct + aggregated edges from the backend (get_subgraph) rather than filtering client-side, feeds them to ELK for routing, and falls back to straight-line edges (also used as the layout guard for views over 1500 rendered nodes or 3000 view edges -- routing cost scales with edges as much as with nodes).
        entry_points: [packages/app/src/canvas/layout/elkLayout.ts, packages/app/src/canvas/layout/edgePhase.ts, packages/app/src/canvas/layout/layoutScheduler.ts, packages/app/src/stores/relayoutPolicy.ts, packages/app/src/canvas/renderers/edgeRoutingBudget.ts]
        depends_on: [graph-model]
        doc: docs/features/graph-layout.md

    graph-model:
        description: Rust data model for code graphs including nodes (Directory, File, CodeBlock), edges with kinds, adjacency indexes, EdgeIndex for O(1) dedup, a NodeMap whose child->parent index is cached and self-invalidating (any &mut access through DerefMut drops it) so interactive queries stop rebuilding it, ParseResult (edge-less IPC payload with per-node connectivity map, borrowing the live node map and shipping slim signature-less nodes; NodeDetails serves the signature on demand), SubGraph extraction that computes direct + aggregated (collapsed-container) view edges server-side, a directional Neighborhood BFS query (FocusDirection both/upstream/downstream applied at every hop, depth-bounded, with container chain) backing node focus, and an EdgeDetail query that inverts aggregation -- re-expanding one aggregated source->target edge into the underlying subtree-to-subtree edges -- backing edge drill-in.
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
        description: Two zoom-level views selected by a toolbar segmented control. Module view (default on load) is the trustworthy zoomed-out import graph -- files render collapsed and only Import edges show, as DERIVED constraints over the user's saved state (never mutating it). Symbol view is the detailed expandable view with all enabled edge kinds. Focus mode is a stack of FocusFrames, each laying out ONLY its fetched ids so the full symbol graph is never laid out. Node frames drill into a bounded neighborhood (cc-core Neighborhood BFS via get_neighborhood, per-frame 1/2-hop depth + both/upstream/downstream trace direction), entered via the F hotkey (hovered node, falling back to the selected one), the canvas selection chip, the Sidebar row or details-panel Focus buttons (the panel also focuses any listed edge endpoint), or a module-view File double-click. Edge frames drill into ONE aggregated edge (cc-core edge_detail via get_edge_detail), showing exactly the symbol pairs behind it, entered by double-clicking an aggregated edge (count > 1) on the canvas; they have no depth/direction. Focusing from inside focus pushes deeper; the breadcrumb trail pops back, X clears the stack, Esc pops exactly one frame. Focus actions are never placed in the hover tooltip, which unmounts on pointerout before it can be clicked. viewMode persists per folder; the focus stack is transient and cleared by module view.
        entry_points: [packages/app/src/stores/graphViewModel.ts, packages/app/src/stores/graphStore.ts, packages/app/src/canvas/Canvas.tsx, packages/app/src/canvas/FocusBreadcrumb.tsx, packages/app/src/canvas/SelectionChip.tsx, packages/app/src/canvas/focusHotkey.ts, packages/app/src/canvas/useEscapeKey.ts, packages/app/src/canvas/renderers/PixiRenderer.ts, crates/cc-core/src/model/graph.rs, crates/cc-tauri/src/commands/parse.rs]
        depends_on: [state-management, graph-layout, graph-model, resolution_precision]
        doc: docs/features/zoom_views.md

    state-management:
        description: Zustand stores for graph state (incl. viewMode, the focus stack and the top frame's neighborhood/edge-detail payload, and the selected node set + derived primary), viewport state, per-view edge-kind counts published by the layout pass (edgeLegendStore), debug logging, and per-folder persistence (expanded/visible/viewMode). Every action routes its change through the pure relayoutPolicy, which bumps at most one layout trigger (layoutVersion for a full ELK layout, edgeVersion for the edge-only phase) and sets needsRelayout purely as the "Apply Layout Changes" hint. Hover setters are equality-guarded so Pixi's repeated events do not wake subscribers. Pure view derivation + focus reducers live in graphViewModel.ts; pure selection logic in selectionModel.ts.
        entry_points: [packages/app/src/stores/graphStore.ts, packages/app/src/stores/graphViewModel.ts, packages/app/src/stores/relayoutPolicy.ts, packages/app/src/stores/selectionModel.ts, packages/app/src/stores/viewportStore.ts, packages/app/src/stores/edgeLegendStore.ts, packages/app/src/stores/debugStore.ts]
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

    details-panel:
        description: >
            Collapsible right-side panel describing the selected node: kind badge, name, and its
            facts (path/language for files and directories, signature/visibility/line span for code
            blocks). Below that, incoming and outgoing edge sections grouped by edge kind with
            EDGE_COLORS swatches and per-kind counts; each row names the other endpoint, selects it
            on click, and carries a Focus button. Fed by a debounced, stale-guarded
            get_neighborhood(selectedNodeId, 1, ALL kinds) fetch -- always all kinds, since the panel
            describes the node rather than the current view. Also holds the prominent Focus action
            for the selected node itself (the hover tooltip cannot hold buttons -- it unmounts on
            pointerout). Grouping/ordering lives in a pure, type-only-import model module.
        entry_points: [packages/app/src/details/DetailsPanel.tsx, packages/app/src/details/detailsPanelModel.ts]
        depends_on: [state-management, graph-model, zoom-views, palette]
        doc: docs/features/details-panel.md

    benchmarking:
        description: >
            Performance measurement across all three layers, with no pass/fail gate anywhere.
            Criterion benches cover cc-core's hot functions on fixtures shaped like real data --
            nested Directory > File > CodeBlock trees rendered with containers COLLAPSED, so
            aggregation actually walks ancestor chains (the previous flat fixture had an empty
            parent map and skipped that path entirely). An end-to-end harness
            (cc-core example perf_harness) runs scan -> parse -> resolve plus the UI's query
            battery -- subgraph extraction at four render-set sizes, neighborhood BFS,
            edge-detail drill-in, parse-payload build + serialize -- and prints one JSON object
            of timings, graph stats and payload bytes; it is written against only the cc-core
            API that is identical across compared branches, so the same binary source measures
            both sides. A seeded Python generator produces byte-identical synthetic repos
            (200/2000/10000 modules, configurable hub-name collision fraction driving resolver
            ambiguity). A node script benchmarks the canvas edge-routing pass, degrading
            gracefully where the obstacle index and routing budget do not exist. run_all.sh
            drives every layer in one pass; the bench workflow uploads the same artifacts on
            demand.
        entry_points: [crates/cc-core/benches/graph_bench.rs, crates/cc-core/benches/parse_bench.rs, crates/cc-core/benches/common/mod.rs, crates/cc-core/examples/perf_harness.rs, benchmarks/gen_repo.py, benchmarks/run_all.sh, packages/app/benchmarks/edgeRouting.bench.ts, .github/workflows/bench.yml]
        depends_on: [graph-model, parsing, resolution_precision, repo-scanning, canvas-rendering]
        doc: docs/features/benchmarking.md

    error-handling:
        description: React ErrorBoundary components wrapping major UI sections for graceful error recovery.
        entry_points: [packages/app/src/components/ErrorBoundary.tsx, packages/app/src/App.tsx]
        depends_on: []
        doc: docs/features/error-handling.md
