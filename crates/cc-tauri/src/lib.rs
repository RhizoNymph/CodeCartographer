pub mod commands;

use cc_core::model::CodeGraph;
use std::sync::Mutex;

/// Shared server-side graph state managed by Tauri.
/// Wraps an `Option<CodeGraph>` — `None` until the first scan completes.
pub struct GraphState(pub Mutex<Option<CodeGraph>>);

impl Default for GraphState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}
