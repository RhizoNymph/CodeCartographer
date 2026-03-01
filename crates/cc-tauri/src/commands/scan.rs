use std::path::PathBuf;

use cc_core::model::CodeGraph;
use cc_core::repo::RepoScanner;
use tauri::command;

#[command]
pub async fn scan_repo(path: String) -> Result<CodeGraph, String> {
    let path = PathBuf::from(&path);

    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    RepoScanner::scan(&path).map_err(|e| e.to_string())
}
