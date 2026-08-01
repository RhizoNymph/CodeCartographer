# Frontend Application

React/TypeScript frontend for code visualization.

## Technology Stack

| Library | Purpose |
|---------|---------|
| React 19 | UI framework |
| TypeScript | Type safety |
| Zustand | State management |
| Pixi.js | WebGL canvas rendering |
| ELK.js | Hierarchical graph layout |
| Vite | Build tool |

## Application Structure

```
packages/app/src/
├── main.tsx          # Entry point
├── App.tsx           # Root component
├── api/
│   ├── commands.ts   # Tauri IPC wrappers
│   └── types.ts      # TypeScript interfaces
├── canvas/
│   ├── Canvas.tsx    # Canvas component
│   ├── Tooltip.tsx   # Hover tooltip
│   ├── layout/elkLayout.ts       # ELK layout
│   ├── culling/cullingManager.ts # Spatial indexing
│   └── renderers/PixiRenderer.ts # Main renderer
├── stores/
│   ├── graphStore.ts    # Graph + visibility state
│   ├── viewportStore.ts # Camera + LOD state
│   └── debugStore.ts    # Debug info
├── toolbar/Toolbar.tsx  # Top controls
└── sidebar/Sidebar.tsx  # Tree view
```

## State Management

### graphStore

Core application state:

```typescript
interface GraphState {
  graph: CodeGraph | null;
  repoPath: string | null;
  isParsing: boolean;
  parseProgress: ParseProgress;
  expandedNodes: Set<string>;
  visibleNodes: Set<string>;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  enabledEdgeKinds: Set<EdgeKind>;
}
```

**Key Actions:**
- `setGraph()` - Load graph, auto-expand directories while files stay collapsed by default
- `handleParseEvent()` - Update progress from streaming events
- `toggleExpanded()` - Expand/collapse node children
- `toggleVisible()` - Toggle node visibility (recursive)
- `toggleEdgeKind()` - Filter edge types

### viewportStore

Camera and level-of-detail:

```typescript
interface ViewportState {
  x, y, width, height, scale: number;
  lodLevel: "minimap" | "overview" | "detail";
}
```

**LOD Thresholds:**
- `minimap`: scale < 0.15 (directories only)
- `overview`: scale < 0.5 (directories + files)
- `detail`: scale >= 0.5 (all nodes)

### debugStore

Development diagnostics:

```typescript
interface DebugState {
  layoutInfo: LayoutInfo | null;
  logs: string[];
}
```

## Canvas Rendering

### PixiRenderer

Main visualization engine using Pixi.js:

**Initialization:**
- Creates Pixi Application with WebGL
- Sets up viewport with zoom/pan via pixi-viewport
- Configures interaction handlers

**Node Rendering:**
- Container with Graphics background + Text label
- Colors based on node type and BlockKind
- Selection highlight (blue border)
- Hover tint effect

**Edge Rendering:**
- Polylines with ELK-provided waypoints
- Color-coded by EdgeKind
- Arrowheads at endpoints
- 0.6 alpha transparency

**Interactions:**
- Click: Select node
- Double-click: Expand/collapse
- Drag: Pan viewport
- Wheel: Zoom

### elkLayout

Computes hierarchical node positions:

```typescript
async function layoutGraph(
  graph: CodeGraph,
  expandedNodes: Set<string>,
  visibleNodes: Set<string>
): Promise<LayoutResult>
```

**ELK Configuration:**
- Algorithm: `layered` (left-to-right)
- Node spacing: 20px
- Layer spacing: 30px
- Edge routing: Orthogonal

**Node Sizes:**
- Directory: 200x60
- File: 180x40
- CodeBlock: 160x32

**Fallback:**
Grid layout (8 columns) if ELK fails.

### Culling Manager

R-tree spatial index for viewport culling:

```typescript
queryViewport(bounds): NodeId[]
```

Available for optimization but not actively used.

## UI Components

### Toolbar

Top bar with controls:

1. **Open Folder** (Ctrl+O) - File dialog to select repository
2. **Clone URL** (Ctrl+G) - Clone GitHub repository
3. **Path Display** - Shows loaded repository
4. **Edge Filters** - Toggle buttons for each EdgeKind

### Sidebar

Left panel tree view:

1. **Search** - Filter by node name
2. **Parse Progress** - Shows during parsing
3. **Tree View** - Recursive TreeItem components
4. **Stats** - Node and edge counts

**TreeItem:**
- Chevron for expand/collapse
- Checkbox for visibility
- Icon for node type
- Name with search highlighting

**Node Icons:**
```
Directory: 📁  File: 📄
Function: ƒ   Class: C    Struct: S
Enum: E       Trait: T    Interface: I
Impl: ⇒       Module: M   Constant: K
TypeAlias: ≡
```

### Tooltip

Displays on node hover:
- Node kind and name
- Signature (for CodeBlocks)
- Language and path (for Files)
- Child count (for Directories)

## Type System

Mirrors Rust backend types:

```typescript
type CodeNode = DirectoryNode | FileNode | CodeBlockNode;

interface CodeGraph {
  nodes: Record<string, CodeNode>;
  edges: CodeEdge[];
  root: string;
}

interface SubGraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
  aggregated_edges: AggregatedEdge[];
}

type EdgeKind =
  | "Import" | "FunctionCall" | "MethodCall"
  | "TypeReference" | "Inheritance" | "TraitImpl"
  | "VariableUsage";

type BlockKind =
  | "Function" | "Class" | "Struct" | "Enum"
  | "Trait" | "Interface" | "Impl" | "Module"
  | "Constant" | "TypeAlias";
```

## Color Scheme

One rule governs the palette: a colour identifies exactly one category. Edges
own the saturated end of the spectrum, blocks and nodes own the muted end, and
no hex is shared between the three maps. Full rationale and invariants live in
`docs/features/palette.md`.

**Edge Hues** (`EDGE_HUES` / `EDGE_COLORS`) — 5 hues for 7 kinds:
```
Import                       #818cf8 (indigo)  flagship module-view edge
FunctionCall + MethodCall    #4ade80 (green)   "a call"
TypeReference                #fbbf24 (amber)
Inheritance + TraitImpl      #f472b6 (pink)    "a subtype relation"
VariableUsage                #94a3b8 (slate)   neutral / de-emphasized
```
Merged kinds stay distinct in the model, tooltips, toggles and `EDGE_STYLES`;
only the colour merges. `MethodCall` is dimmed below `FunctionCall`
(baseAlpha 0.65 vs 0.8) so the shared hue is still separable.

**BlockKind Colors** — one muted family (HSL sat 42%, lightness 62%) so node
fills recede and edges pop:
```
Function:  #758fc7 (blue)     Interface: #75bdc7 (cyan)
Class:     #bb75c7 (purple)   Impl:      #a9c775 (lime)
Struct:    #c7b775 (sand)     Module:    #c77b75 (clay)
Enum:      #75c787 (green)    Constant:  #c79975 (tan)
Trait:     #c7759e (rose)     TypeAlias: #75c7ad (teal)
```
Block hues avoid the indigo/slate band owned by the Import and VariableUsage
edges — which is why `Impl` (was indigo `#6366f1`, the Import hex) and `Module`
(was slate `#64748b`, the VariableUsage hex) moved to lime and clay.

**Node Types:**
```
Directory: #1e293b (dark slate)
File: #1e3a5f (dark blue)
```
Node fills darken their palette colour by `BLOCK_FILL_DARKEN` (0.25).

## Data Flow

### Load Workflow

```
User selects folder
    ↓
scanRepo(path)
    ↓
setGraph() → auto-expand
    ↓
Canvas displays skeleton
    ↓
parseRepo(path, graph, onEvent)
    ↓
handleParseEvent() → progress updates
    ↓
setGraph() with full graph
    ↓
layoutGraph() via ELK
    ↓
renderFromLayout()
    ↓
Canvas displays full visualization
```

### Interaction Workflow

```
User expands node in sidebar
    ↓
toggleExpanded(nodeId)
    ↓
Canvas effect triggers
    ↓
layoutGraph() recalculates
    ↓
renderFromLayout()
```

## Dependencies

**Production:**
- `@tauri-apps/api` - IPC communication
- `@tauri-apps/plugin-dialog` - Native dialogs
- `react`, `react-dom` - UI framework
- `zustand` - State management
- `pixi.js` - WebGL rendering
- `pixi-viewport` - Camera controls
- `elkjs` - Graph layout
- `rbush` - Spatial index

**Development:**
- `typescript` - Type checking
- `vite` - Build/dev server
- `@vitejs/plugin-react` - React support
