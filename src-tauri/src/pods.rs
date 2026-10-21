use std::{
    pin::pin,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use futures::StreamExt;
use k8s_openapi::{api::core::v1::Pod, apimachinery::pkg::apis::meta::v1::Time};
use kube::{
    Api, ResourceExt,
    api::ListParams,
    runtime::{WatchStreamExt, reflector, watcher},
};
use serde::Serialize;
use tauri::{
    State,
    async_runtime::{self, JoinHandle},
    ipc::Channel,
};
use tokio::time::{MissedTickBehavior, interval, timeout};

use crate::{clients::Clients, kubeconfig::KubeconfigSources};

/// Changes are coalesced and pushed to the UI at most this often, so a burst
/// of pod events costs one render instead of hundreds.
const FLUSH_INTERVAL: Duration = Duration::from_millis(150);

/// While the API is unreachable, check it this often to report recovery.
const HEALTH_INTERVAL: Duration = Duration::from_secs(5);

/// A reachability probe that takes longer than this counts as a failure.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Only one pod watch runs at a time: the one for the view on screen.
#[derive(Default)]
pub struct PodWatch {
    generation: AtomicU64,
    task: Mutex<Option<JoinHandle<()>>>,
}

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

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PodEvent {
    Snapshot {
        pods: Vec<PodRow>,
    },
    Error {
        message: String,
    },
    /// The API answers again after an `Error`.
    Recovered,
}

#[tauri::command]
pub async fn watch_pods(
    context: String,
    namespace: Option<String>,
    on_event: Channel<PodEvent>,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
    watch: State<'_, PodWatch>,
) -> Result<(), String> {
    // A newer call may start while this one awaits the client; the newer one wins.
    let generation = watch.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let client = clients.get(&sources, &context).await?;
    if watch.generation.load(Ordering::SeqCst) != generation {
        return Ok(());
    }

    let api: Api<Pod> = match namespace.as_deref() {
        Some(ns) => Api::namespaced(client, ns),
        None => Api::all(client),
    };
    let task = async_runtime::spawn(run_watch(api, on_event));
    if let Some(previous) = watch.task.lock().unwrap().replace(task) {
        previous.abort();
    }
    Ok(())
}

#[tauri::command]
pub fn stop_pod_watch(watch: State<'_, PodWatch>) {
    watch.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(task) = watch.task.lock().unwrap().take() {
        task.abort();
    }
}

async fn run_watch(api: Api<Pod>, channel: Channel<PodEvent>) {
    let (store, writer) = reflector::store::<Pod>();
    let mut events =
        pin!(reflector(writer, watcher(api.clone(), watcher::Config::default())).default_backoff());
    let mut ticker = interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut health = interval(HEALTH_INTERVAL);
    health.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut ready = false;
    let mut dirty = false;
    let mut disconnected = false;

    loop {
        tokio::select! {
            event = events.next() => match event {
                Some(Ok(watcher::Event::InitDone)) => {
                    ready = true;
                    dirty = true;
                }
                Some(Ok(_)) => dirty = true,
                // Load balancers cut idle watch connections, and the watcher then
                // resumes from its last version without emitting anything. So a
                // stream error is only reported when the API itself stops answering.
                Some(Err(err)) => {
                    if !disconnected && !reachable(&api).await {
                        disconnected = true;
                        let message = err.to_string();
                        if channel.send(PodEvent::Error { message }).is_err() {
                            return;
                        }
                    }
                }
                None => return,
            },
            _ = health.tick(), if disconnected => {
                if reachable(&api).await {
                    disconnected = false;
                    dirty = true;
                    if channel.send(PodEvent::Recovered).is_err() {
                        return;
                    }
                }
            }
            _ = ticker.tick(), if ready && dirty => {
                dirty = false;
                let mut pods: Vec<PodRow> = store.state().iter().map(|pod| pod_row(pod)).collect();
                pods.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
                if channel.send(PodEvent::Snapshot { pods }).is_err() {
                    return;
                }
            }
        }
    }
}

/// Cheapest request that proves the API answers for this scope.
async fn reachable(api: &Api<Pod>) -> bool {
    let params = ListParams::default().limit(1);
    let probe = api.list_metadata(&params);
    matches!(timeout(PROBE_TIMEOUT, probe).await, Ok(Ok(_)))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unreachable_api_is_detected() {
        // Nothing listens on port 1, so the probe fails fast.
        let config = kube::Config::new("https://127.0.0.1:1".parse().unwrap());
        let client = kube::Client::try_from(config).unwrap();
        assert!(!reachable(&Api::<Pod>::all(client)).await);
    }
}
