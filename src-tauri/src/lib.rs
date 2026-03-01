use cc_tauri::commands;

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
