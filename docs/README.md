# CodeCartographer Documentation

CodeCartographer is a desktop application for visualizing code structure and dependencies as an interactive graph. It parses source code using Tree-sitter and renders a hierarchical graph showing relationships between files, functions, classes, and other code elements.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (React/TS)                      │
│  ┌──────────┐  ┌─────────┐  ┌───────────┐  ┌──────────────┐ │
│  │ Toolbar  │  │ Sidebar │  │  Canvas   │  │ State Stores │ │
│  └──────────┘  └─────────┘  │ (Pixi.js) │  │  (Zustand)   │ │
│                             └───────────┘  └──────────────┘ │
└──────────────────────────┬──────────────────────────────────┘
                           │ Tauri IPC (JSON)
┌──────────────────────────▼──────────────────────────────────┐
│                    cc-tauri (Commands)                       │
│    scan_repo │ parse_repo │ get_subgraph │ clone_github_repo │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                     cc-core (Engine)                         │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌────────────┐  │
│  │  Parser  │  │  Model   │  │  Resolver │  │    Repo    │  │
│  │(TreeSit) │  │ (Graph)  │  │ (Symbols) │  │  (Scanner) │  │
│  └──────────┘  └──────────┘  └───────────┘  └────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Technology Stack

| Layer | Technology |
|-------|------------|
| Desktop Framework | Tauri 2 |
| Backend | Rust |
| Parsing | Tree-sitter |
| Frontend | React 19 + TypeScript |
| State Management | Zustand |
| Visualization | Pixi.js (WebGL) |
| Layout | ELK.js |
| Build | Vite + Cargo |

## Supported Languages

- Python
- TypeScript
- JavaScript
- Rust

## Documentation Index

| Document | Description |
|----------|-------------|
| [cc-core.md](./cc-core.md) | Core parsing engine and graph model |
| [cc-tauri.md](./cc-tauri.md) | Tauri command handlers (backend API) |
| [frontend.md](./frontend.md) | React frontend and visualization |
| [tauri-app.md](./tauri-app.md) | Desktop app configuration |

## Quick Start

```bash
# Install dependencies
pnpm install

# Run in development
pnpm tauri dev

# Build for production
pnpm tauri build
```

## Data Flow

1. **Scan**: `RepoScanner` walks directory tree, creates Directory/File nodes
2. **Parse**: `Extractor` uses Tree-sitter to extract code blocks and references
3. **Resolve**: `SymbolTable` + resolvers convert references to graph edges
4. **Layout**: ELK.js computes hierarchical node positions
5. **Render**: Pixi.js draws nodes and edges on WebGL canvas
