use std::path::PathBuf;

use cc_core::model::CodeGraph;
use cc_core::repo::RepoScanner;
use tauri::command;

use crate::GraphState;

#[command]
pub async fn scan_repo(
    path: String,
    state: tauri::State<'_, GraphState>,
) -> Result<CodeGraph, String> {
    let path = PathBuf::from(&path);

    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    let graph = RepoScanner::scan(&path).map_err(|e| e.to_string())?;

    // Store graph in server-side state
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        *guard = Some(graph.clone());
    }

    Ok(graph)
}
