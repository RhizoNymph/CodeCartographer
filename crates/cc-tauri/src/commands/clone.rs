use cc_core::repo::clone_repo;
use tauri::command;

#[command]
pub async fn clone_github_repo(url: String) -> Result<String, String> {
    let tmp_dir = std::env::temp_dir().join("codecartographer-repos");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let clone_path = clone_repo(&url, &tmp_dir).map_err(|e| e.to_string())?;

    Ok(clone_path.to_string_lossy().to_string())
}
