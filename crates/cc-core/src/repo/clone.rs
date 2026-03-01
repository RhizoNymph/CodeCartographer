use std::path::{Path, PathBuf};
use std::process::Command;

/// Clone a GitHub repository to a temporary directory.
pub fn clone_repo(url: &str, target_dir: &Path) -> anyhow::Result<PathBuf> {
    // Validate URL
    if !url.starts_with("https://github.com/")
        && !url.starts_with("git@github.com:")
        && !url.starts_with("https://gitlab.com/")
        && !url.starts_with("git@gitlab.com:")
    {
        anyhow::bail!("Only GitHub and GitLab URLs are supported");
    }

    // Extract repo name for the folder
    let repo_name = url
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit('/')
        .next()
        .unwrap_or("repo");

    let clone_path = target_dir.join(repo_name);

    if clone_path.exists() {
        tracing::info!("Repository already exists at {}", clone_path.display());
        return Ok(clone_path);
    }

    tracing::info!("Cloning {} to {}", url, clone_path.display());

    let output = Command::new("git")
        .args(["clone", "--depth", "1", url, &clone_path.to_string_lossy()])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git clone failed: {}", stderr);
    }

    Ok(clone_path)
}
