use std::path::PathBuf;

use cc_core::model::ParseResponse;
use cc_core::repo::RepoScanner;
use tauri::command;

use crate::GraphState;

#[command]
pub async fn scan_repo(
    path: String,
    state: tauri::State<'_, GraphState>,
) -> Result<ParseResponse, String> {
    let path = PathBuf::from(&path);

    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    let graph = RepoScanner::scan(&path).map_err(|e| e.to_string())?;

    // Hand the graph to server-side state and answer with a handle to the same
    // allocation: the edge-less response (scan produces no edges) serializes
    // straight out of the live node map, copying nothing.
    Ok(ParseResponse(state.store(graph)?))
}
