pub mod commands;

use cc_core::model::CodeGraph;
use std::sync::{Arc, RwLock};

/// Shared server-side graph state managed by Tauri.
///
/// `None` until the first scan completes. The graph is held behind an `Arc` so a
/// reader can clone the handle under a short read lock and then work without
/// holding the lock at all -- which is what lets the query commands run on the
/// blocking pool concurrently, and lets a parse response borrow the same
/// allocation the state keeps instead of copying the node map.
pub struct GraphState(pub RwLock<Option<Arc<CodeGraph>>>);

impl Default for GraphState {
    fn default() -> Self {
        Self(RwLock::new(None))
    }
}

impl GraphState {
    /// Clone the current graph handle (cheap: one `Arc` bump), releasing the
    /// read lock immediately. Errors when no scan has run yet.
    pub fn snapshot(&self) -> Result<Arc<CodeGraph>, String> {
        let guard = self
            .0
            .read()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        guard
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| "No graph in state. Run scan_repo first.".to_string())
    }

    /// Replace the stored graph, returning the handle that was installed.
    pub fn store(&self, graph: CodeGraph) -> Result<Arc<CodeGraph>, String> {
        let arc = Arc::new(graph);
        let mut guard = self
            .0
            .write()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        *guard = Some(Arc::clone(&arc));
        Ok(arc)
    }

    /// Take the stored graph for mutation.
    ///
    /// The `Arc` is unwrapped when this is the only handle (the normal case: the
    /// previous response has long since been serialized and dropped). A reader
    /// holding a snapshot mid-flight forces a copy instead, which is correct but
    /// worth knowing about, hence the warning.
    pub fn take_for_mutation(&self) -> Result<CodeGraph, String> {
        let arc = {
            let mut guard = self
                .0
                .write()
                .map_err(|e| format!("Lock poisoned: {}", e))?;
            guard
                .take()
                .ok_or_else(|| "No graph in state. Run scan_repo first.".to_string())?
        };
        match Arc::try_unwrap(arc) {
            Ok(graph) => Ok(graph),
            Err(shared) => {
                tracing::warn!("Graph still shared with an in-flight reader; copying to mutate");
                Ok((*shared).clone())
            }
        }
    }
}
