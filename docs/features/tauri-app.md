# Tauri Application Setup

Desktop application configuration and integration.

## Project Structure

```
CodeCartographer/
├── src-tauri/            # Tauri backend
│   ├── Cargo.toml        # Rust dependencies
│   ├── tauri.conf.json   # Tauri configuration
│   ├── build.rs          # Build script
│   ├── capabilities/     # Permission ACL
│   └── src/
│       ├── main.rs       # Entry point
│       └── lib.rs        # App builder
├── crates/
│   ├── cc-core/          # Core engine
│   └── cc-tauri/         # Command handlers
└── packages/
    └── app/              # React frontend
```

## Configuration

### tauri.conf.json

```json
{
  "productName": "CodeCartographer",
  "identifier": "dev.codecartographer.app",
  "version": "0.1.0",
  "build": {
    "frontendDist": "../packages/app/dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "pnpm --filter app dev",
    "beforeBuildCommand": "pnpm --filter app build"
  },
  "app": {
    "windows": [{
      "title": "CodeCartographer",
      "width": 1400,
      "height": 900,
      "resizable": true
    }]
  }
}
```

### Capabilities (ACL)

`capabilities/default.json`:

```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:default",
    "dialog:allow-open"
  ]
}
```

## Entry Point

### main.rs

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tracing_subscriber::fmt::init();
    code_cartographer_lib::run();
}
```

- Hides console window on Windows release builds
- Initializes tracing/logging
- Delegates to library

### lib.rs

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::scan_repo,
            commands::parse_repo,
            commands::get_subgraph,
            commands::clone_github_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## Plugins

| Plugin | Purpose |
|--------|---------|
| tauri-plugin-dialog | Native file/folder dialogs |

## Workspace Configuration

### Root Cargo.toml

```toml
[workspace]
members = ["crates/cc-core", "crates/cc-tauri", "src-tauri"]
resolver = "2"

[workspace.package]
version = "0.1.0"
edition = "2021"

[profile.dev]
opt-level = 1
[profile.dev.package."*"]
opt-level = 3
```

### src-tauri/Cargo.toml

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
cc-core = { workspace = true }
cc-tauri = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = "0.3"
```

## Build Process

### Development

```bash
pnpm tauri dev
```

1. Starts Vite dev server on port 5173
2. Builds Rust backend
3. Opens Tauri window pointing to dev server
4. Hot reload for frontend changes

### Production

```bash
pnpm tauri build
```

1. Runs `pnpm --filter app build` (Vite production build)
2. Compiles Rust in release mode
3. Bundles platform-specific installer

## Platform Support

| Platform | Format |
|----------|--------|
| Windows | MSI, EXE |
| macOS | DMG, APP |
| Linux | AppImage, DEB |

## Application Lifecycle

```
main.rs
    ↓
Initialize tracing
    ↓
lib::run()
    ↓
Tauri Builder
  ├─ Load plugins (dialog)
  ├─ Register commands
  ├─ Load config from tauri.conf.json
    ↓
Create main window (1400x900)
    ↓
Load frontend
  ├─ Dev: http://localhost:5173
  └─ Prod: bundled files
    ↓
Event loop
    ↓
IPC command handling
```

## Frontend-Backend Communication

```
Frontend                          Backend
   │                                 │
   │  invoke("scan_repo", {path})   │
   │ ───────────────────────────────>│
   │                                 │ deserialize JSON
   │                                 │ call cc-core
   │                                 │ serialize result
   │  <Promise<CodeGraph>>          │
   │ <───────────────────────────────│
   │                                 │
   │  Channel<ParseEvent>            │
   │ ───────────────────────────────>│
   │                                 │
   │  onmessage(FileStart)          │
   │ <───────────────────────────────│
   │  onmessage(FileDone)           │
   │ <───────────────────────────────│
   │  ...                            │
   │  <Promise<CodeGraph>>          │
   │ <───────────────────────────────│
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| RUST_LOG | Tracing log level |
| TAURI_DEBUG | Debug build flag |

## Icons

Located in `src-tauri/icons/`:

- 32x32.png, 128x128.png, icon.png
- icon.ico (Windows)
- icon.icns (macOS)

## Security

- CSP disabled for local resource access
- ACL restricts permissions per window
- Only GitHub/GitLab URLs allowed for cloning
- Path validation before file operations
