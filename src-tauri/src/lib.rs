use tauri::Manager;

mod actions;
mod appearance;
mod clients;
mod contexts;
mod custom;
mod details;
mod forwards;
mod kubeconfig;
mod logs;
mod metrics;
mod nodes;
mod pods;
mod resources;
mod sessions;
mod shell;
mod watch;

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
        .manage(watch::ViewWatch::default())
        .manage(sessions::Sessions::default())
        .manage(forwards::Forwards::default())
        .invoke_handler(tauri::generate_handler![
            contexts::list_contexts,
            contexts::add_kubeconfig,
            contexts::remove_kubeconfig,
            contexts::update_cluster,
            contexts::list_namespaces,
            appearance::get_transparency,
            appearance::set_transparency,
            pods::watch_pods,
            resources::list_resource_kinds,
            resources::watch_resources,
            custom::list_custom_kinds,
            details::describe_resource,
            actions::delete_resource,
            actions::restart_workload,
            actions::scale_workload,
            actions::get_resource_yaml,
            actions::apply_resource_yaml,
            actions::create_resources,
            metrics::get_metrics,
            nodes::cordon_node,
            nodes::drain_node,
            watch::stop_watch,
            logs::open_logs,
            logs::open_workload_logs,
            logs::save_log,
            shell::open_shell,
            shell::shell_input,
            shell::shell_resize,
            sessions::close_session,
            forwards::list_forward_ports,
            forwards::start_port_forward,
            forwards::suggest_local_port,
            forwards::stop_port_forward,
            forwards::list_port_forwards,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
