use tauri::Manager;

mod appearance;
mod clients;
mod contexts;
mod kubeconfig;
mod logs;
mod pods;
mod sessions;
mod shell;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = app.path();
            let sources =
                kubeconfig::KubeconfigSources::load(paths.app_config_dir()?, paths.home_dir()?);
            if sources.transparency() > 0
                && let Some(window) = app.get_webview_window("main")
            {
                appearance::apply_vibrancy(&window, true)?;
            }
            app.manage(sources);
            Ok(())
        })
        .manage(clients::Clients::default())
        .manage(pods::PodWatch::default())
        .manage(sessions::Sessions::default())
        .invoke_handler(tauri::generate_handler![
            contexts::list_contexts,
            contexts::add_kubeconfig,
            contexts::remove_kubeconfig,
            contexts::update_cluster,
            contexts::list_namespaces,
            appearance::get_transparency,
            appearance::set_transparency,
            pods::watch_pods,
            pods::stop_pod_watch,
            logs::open_logs,
            shell::open_shell,
            shell::shell_input,
            shell::shell_resize,
            sessions::close_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
