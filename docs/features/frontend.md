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
│   ├── interaction/
│   │   └── interactionManager.ts  # Node drag handling
│   ├── layout/
│   │   ├── elkLayout.ts       # ELK hierarchical layout
│   │   └── edgeGeometry.ts    # Edge polyline anchoring
│   ├── culling/
│   │   └── cullingManager.ts  # R-tree spatial indexing
│   └── renderers/
│       ├── PixiRenderer.ts    # Main renderer orchestrator
│       ├── NodeRenderer.ts    # Individual node rendering
│       ├── EdgeRenderer.ts    # Edge path and arrowhead rendering
│       └── LabelRenderer.ts   # LOD-aware text label management
├── stores/
│   ├── graphStore.ts       # Graph + visibility state
│   ├── viewportStore.ts    # Camera + LOD state
│   ├── debugStore.ts       # Debug info
│   └── persistenceStore.ts # LocalStorage persistence
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

### persistenceStore

LocalStorage-backed persistence for UI state:

```typescript
interface FolderState {
  expandedNodes: string[];
  visibleNodes: string[];
}
```

**Exports:**
- `saveLastFolder(path)` - Remember last opened folder
- `getLastFolder()` - Retrieve last opened folder
- `clearLastFolder()` - Clear last folder record
- `saveFolderState(path, expanded, visible)` - Save expand/visibility state for a folder
- `loadFolderState(path)` - Restore expand/visibility state for a folder

Uses a simple hash of the folder path as the localStorage key prefix.

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

### NodeRenderer

Static utility class for creating Pixi display objects for individual nodes.

**Key methods:**
- `createNode(node, options)` - Creates a Container with Graphics background + Text label
- `getNodeColor(node)` - Returns hex color based on node type (Directory: dark slate, File: dark blue, CodeBlock: darkened BlockKind color)
- `getNodeLabel(node)` - Returns display text with kind prefix for code blocks (e.g., "fn main", "class Foo")
- `blockKindPrefix(kind)` - Maps BlockKind to short prefix string

**File:** `packages/app/src/canvas/renderers/NodeRenderer.ts`

### EdgeRenderer

Manages a single Graphics object for rendering all edges.

**Key methods:**
- `setEnabledKinds(kinds)` - Set which edge types to render
- `render(edges)` - Clear and redraw all edges as color-coded polylines with arrowheads
- `destroy()` - Clean up Graphics resources

**Rendering details:**
- Polyline paths from layout waypoints
- Color-coded by EdgeKind using EDGE_COLORS map
- Arrowheads at endpoints (8px, ±30°)
- 0.6 alpha for paths, 0.8 alpha for arrowheads

**File:** `packages/app/src/canvas/renderers/EdgeRenderer.ts`

### LabelRenderer

Manages text labels with LOD-based visibility control.

**Key methods:**
- `createLabel(id, text, x, y, fontSize, color, parent)` - Create and track a text label
- `updateLOD(lodLevel)` - Show/hide labels based on zoom level
- `clear()` / `destroy()` - Clean up all labels

**LOD behavior:**
- Code block labels (id contains "::") - visible only at "detail" level
- Directory/File labels - hidden at "minimap", font size 10 at "overview", font size 13 at "detail"

**File:** `packages/app/src/canvas/renderers/LabelRenderer.ts`

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

### InteractionManager

Handles node drag-and-drop interactions.

**Interface:**
```typescript
interface DragState {
  nodeId: string;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}
```

**Key methods:**
- `setOnNodeMoved(callback)` - Register callback for when a node is dropped
- `startDrag(nodeId, container, event)` - Begin tracking a drag
- `updateDrag(event, container)` - Move the container to follow the pointer
- `endDrag(container)` - Finalize the drag and fire the callback
- `isDragging()` / `getDragNodeId()` - Query drag state

**File:** `packages/app/src/canvas/interaction/interactionManager.ts`

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

## Files Related to This Feature

| File | Role | Key Exports |
|------|------|-------------|
| `packages/app/src/main.tsx` | Entry point | React root mount |
| `packages/app/src/App.tsx` | Root layout | App component |
| `packages/app/src/api/commands.ts` | Tauri IPC wrappers | scanRepo, parseRepo, getSubgraph, cloneGithubRepo |
| `packages/app/src/api/types.ts` | TypeScript interfaces | CodeNode, CodeGraph, SubGraph, EdgeKind, BlockKind, BLOCK_COLORS, EDGE_COLORS |
| `packages/app/src/canvas/Canvas.tsx` | Canvas container | Canvas component |
| `packages/app/src/canvas/Tooltip.tsx` | Hover tooltip | Tooltip component |
| `packages/app/src/canvas/renderers/PixiRenderer.ts` | Main renderer orchestrator | PixiRenderer class |
| `packages/app/src/canvas/renderers/NodeRenderer.ts` | Node display objects | NodeRenderer class |
| `packages/app/src/canvas/renderers/EdgeRenderer.ts` | Edge path rendering | EdgeRenderer class |
| `packages/app/src/canvas/renderers/LabelRenderer.ts` | LOD-aware labels | LabelRenderer class |
| `packages/app/src/canvas/layout/elkLayout.ts` | Graph layout | layoutGraph function |
| `packages/app/src/canvas/layout/edgeGeometry.ts` | Edge polyline anchoring | Edge routing utilities |
| `packages/app/src/canvas/culling/cullingManager.ts` | R-tree spatial index | queryViewport |
| `packages/app/src/canvas/interaction/interactionManager.ts` | Node drag handling | InteractionManager class |
| `packages/app/src/stores/graphStore.ts` | Core state | useGraphStore |
| `packages/app/src/stores/viewportStore.ts` | Viewport/LOD state | useViewportStore |
| `packages/app/src/stores/debugStore.ts` | Debug diagnostics | useDebugStore |
| `packages/app/src/stores/persistenceStore.ts` | LocalStorage persistence | saveLastFolder, saveFolderState, loadFolderState |
| `packages/app/src/toolbar/Toolbar.tsx` | Top controls | Toolbar component |
| `packages/app/src/sidebar/Sidebar.tsx` | Tree view | Sidebar component |

## Invariants and Constraints

- TypeScript types in `api/types.ts` must mirror the Rust `cc-core` model types exactly (serde JSON round-trip).
- The graph store is the single source of truth for graph data. All components read from it; only store actions mutate it.
- Layout (ELK.js) runs asynchronously and must complete before rendering. If layout fails, a grid fallback is used.
- LOD levels are determined solely by viewport scale thresholds. Components must not bypass the viewport store for LOD decisions.
- Persistence keys are hashed from folder paths. Collisions are theoretically possible but not guarded against.
- The renderer expects node positions from layout data — it does not compute positions itself.
- Edge filtering happens at both the subgraph extraction level (backend) and the render level (EdgeRenderer.setEnabledKinds).
