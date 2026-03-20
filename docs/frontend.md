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
- `setGraph()` - Load graph, auto-expand directories/files
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

**Node Types:**
```
Directory: #1e293b (dark slate)
File: #1e3a5f (dark blue)
```

**BlockKind Colors:**
```
Function:  #3b82f6 (blue)
Class:     #8b5cf6 (purple)
Struct:    #f59e0b (amber)
Enum:      #10b981 (emerald)
Trait:     #ec4899 (pink)
Interface: #06b6d4 (cyan)
Impl:      #6366f1 (indigo)
Module:    #64748b (slate)
Constant:  #f97316 (orange)
TypeAlias: #14b8a6 (teal)
```

**Edge Colors:** (see cc-core.md EdgeKind table)

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
