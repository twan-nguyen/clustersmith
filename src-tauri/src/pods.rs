use k8s_openapi::{api::core::v1::Pod, apimachinery::pkg::apis::meta::v1::Time};
use kube::{Api, ResourceExt};
use serde::Serialize;
use tauri::{State, ipc::Channel};

use crate::{
    clients::Clients,
    kubeconfig::KubeconfigSources,
    watch::{ViewWatch, WatchEvent, run_watch},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodRow {
    uid: String,
    name: String,
    namespace: String,
    status: String,
    ready: u32,
    containers: u32,
    container_names: Vec<String>,
    restarts: i32,
    created_at: Option<Time>,
    node: Option<String>,
}

#[tauri::command]
pub async fn watch_pods(
    context: String,
    namespace: Option<String>,
    on_event: Channel<WatchEvent<PodRow>>,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
    watch: State<'_, ViewWatch>,
) -> Result<(), String> {
    let generation = watch.begin();
    let client = clients.get(&sources, &context).await?;
    let api: Api<Pod> = match namespace.as_deref() {
        Some(ns) => Api::namespaced(client, ns),
        None => Api::all(client),
    };
    watch.start(generation, run_watch(api, (), on_event, pod_row));
    Ok(())
}

fn pod_row(pod: &Pod) -> PodRow {
    let statuses = pod
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_deref())
        .unwrap_or_default();

    PodRow {
        uid: pod.uid().unwrap_or_default(),
        name: pod.name_any(),
        namespace: pod.namespace().unwrap_or_default(),
        status: pod_status(pod),
        ready: statuses.iter().filter(|c| c.ready).count() as u32,
        containers: pod.spec.as_ref().map_or(0, |s| s.containers.len() as u32),
        container_names: pod
            .spec
            .iter()
            .flat_map(|s| s.containers.iter().map(|c| c.name.clone()))
            .collect(),
        restarts: statuses.iter().map(|c| c.restart_count).sum(),
        created_at: pod.metadata.creation_timestamp.clone(),
        node: pod.spec.as_ref().and_then(|s| s.node_name.clone()),
    }
}

/// Mirrors the STATUS column of `kubectl get pods`: a container's waiting or
/// terminated reason beats the pod phase, because it says why it is stuck.
fn pod_status(pod: &Pod) -> String {
    if pod.metadata.deletion_timestamp.is_some() {
        return "Terminating".into();
    }
    let status = pod.status.as_ref();
    let container_reason = status
        .and_then(|s| s.container_statuses.as_deref())
        .unwrap_or_default()
        .iter()
        .filter_map(|c| c.state.as_ref())
        .find_map(|state| {
            state
                .waiting
                .as_ref()
                .and_then(|w| w.reason.clone())
                .or_else(|| state.terminated.as_ref().and_then(|t| t.reason.clone()))
        });

    container_reason
        .or_else(|| status.and_then(|s| s.reason.clone()))
        .or_else(|| status.and_then(|s| s.phase.clone()))
        .unwrap_or_else(|| "Unknown".into())
}
