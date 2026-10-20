mod clients;
mod contexts;
mod pods;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(clients::Clients::default())
        .manage(pods::PodWatch::default())
        .invoke_handler(tauri::generate_handler![
            contexts::list_contexts,
            contexts::list_namespaces,
            pods::watch_pods,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
