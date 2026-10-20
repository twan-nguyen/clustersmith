use tauri::Manager;

mod clients;
mod contexts;
mod kubeconfig;
mod pods;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = app.path();
            let sources =
                kubeconfig::KubeconfigSources::load(paths.app_config_dir()?, paths.home_dir()?);
            app.manage(sources);
            Ok(())
        })
        .manage(clients::Clients::default())
        .manage(pods::PodWatch::default())
        .invoke_handler(tauri::generate_handler![
            contexts::list_contexts,
            contexts::add_kubeconfig,
            contexts::remove_kubeconfig,
            contexts::list_namespaces,
            pods::watch_pods,
            pods::stop_pod_watch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
