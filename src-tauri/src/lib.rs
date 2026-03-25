use cc_tauri::commands;
use cc_tauri::GraphState;

struct NoRestore(bool);

#[tauri::command]
fn check_norestore(state: tauri::State<'_, NoRestore>) -> bool {
    state.0
}

pub fn run() {
    let norestore = std::env::args().any(|a| a == "--norestore");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(NoRestore(norestore))
        .manage(GraphState::default())
        .invoke_handler(tauri::generate_handler![
            commands::scan_repo,
            commands::parse_repo,
            commands::get_subgraph,
            commands::clone_github_repo,
            check_norestore,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
