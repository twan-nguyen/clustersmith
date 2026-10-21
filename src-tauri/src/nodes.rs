use std::time::Duration;

use futures::future::join_all;
use k8s_openapi::api::core::v1::{Node, Pod};
use kube::{
    Api, ResourceExt,
    api::{EvictParams, ListParams, Patch, PatchParams},
};
use serde::Serialize;
use serde_json::json;
use tauri::State;
use tokio::time::{Instant, sleep};

use crate::{clients::Clients, kubeconfig::KubeconfigSources};

/// A disruption budget may refuse an eviction for a while; retry this long.
const EVICT_TIMEOUT: Duration = Duration::from_secs(90);
const EVICT_RETRY: Duration = Duration::from_secs(5);

#[tauri::command]
pub async fn cordon_node(
    context: String,
    name: String,
    cordon: bool,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<(), String> {
    let client = clients.get(&sources, &context).await?;
    set_unschedulable(&Api::all(client), &name, cordon).await
}

async fn set_unschedulable(api: &Api<Node>, name: &str, value: bool) -> Result<(), String> {
    let patch = json!({ "spec": { "unschedulable": value } });
    api.patch(name, &PatchParams::default(), &Patch::Merge(patch))
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DrainReport {
    evicted: Vec<String>,
    /// DaemonSet and static pods, which belong on every node.
    skipped: Vec<String>,
    /// Pods no controller would recreate. Without `force` the drain stops
    /// before evicting anything, so the user can decide.
    unmanaged: Vec<String>,
    failed: Vec<Failure>,
}

#[derive(Serialize)]
pub struct Failure {
    pod: String,
    error: String,
}

/// Like `kubectl drain --ignore-daemonsets --delete-emptydir-data`: cordon
/// the node, then evict its pods through the eviction API so disruption
/// budgets are respected.
#[tauri::command]
pub async fn drain_node(
    context: String,
    name: String,
    force: bool,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<DrainReport, String> {
    let client = clients.get(&sources, &context).await?;
    set_unschedulable(&Api::all(client.clone()), &name, true).await?;

    let params = ListParams::default().fields(&format!("spec.nodeName={name}"));
    let pods = Api::<Pod>::all(client.clone())
        .list(&params)
        .await
        .map_err(|e| e.to_string())?
        .items;

    let mut report = DrainReport::default();
    let mut to_evict = Vec::new();
    for pod in pods {
        let id = format!("{}/{}", pod.namespace().unwrap_or_default(), pod.name_any());
        match classify(&pod) {
            Class::Keep => report.skipped.push(id),
            Class::Unmanaged => {
                report.unmanaged.push(id);
                to_evict.push(pod);
            }
            Class::Evict => to_evict.push(pod),
        }
    }
    if !report.unmanaged.is_empty() && !force {
        return Ok(report);
    }

    let results = join_all(to_evict.iter().map(|pod| {
        let api: Api<Pod> = Api::namespaced(client.clone(), &pod.namespace().unwrap_or_default());
        async move { (pod, evict(&api, &pod.name_any()).await) }
    }))
    .await;
    for (pod, result) in results {
        let id = format!("{}/{}", pod.namespace().unwrap_or_default(), pod.name_any());
        match result {
            Ok(()) => report.evicted.push(id),
            Err(error) => report.failed.push(Failure { pod: id, error }),
        }
    }
    Ok(report)
}

enum Class {
    Keep,
    Unmanaged,
    Evict,
}

fn classify(pod: &Pod) -> Class {
    let mirror = pod
        .annotations()
        .contains_key("kubernetes.io/config.mirror");
    let controller = pod
        .owner_references()
        .iter()
        .find(|o| o.controller == Some(true));
    match controller {
        _ if mirror => Class::Keep,
        Some(owner) if owner.kind == "DaemonSet" => Class::Keep,
        Some(_) => Class::Evict,
        None => Class::Unmanaged,
    }
}

/// Evicts one pod, waiting out a disruption budget for a while.
async fn evict(api: &Api<Pod>, name: &str) -> Result<(), String> {
    let deadline = Instant::now() + EVICT_TIMEOUT;
    loop {
        match api.evict(name, &EvictParams::default()).await {
            Ok(_) => return Ok(()),
            // Already gone counts as evicted.
            Err(kube::Error::Api(status)) if status.code == 404 => return Ok(()),
            Err(kube::Error::Api(status)) if status.code == 429 && Instant::now() < deadline => {
                sleep(EVICT_RETRY).await;
            }
            Err(err) => return Err(err.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference;

    use super::*;

    fn owned_by(kind: &str) -> Pod {
        let mut pod = Pod::default();
        pod.metadata.owner_references = Some(vec![OwnerReference {
            kind: kind.into(),
            controller: Some(true),
            ..Default::default()
        }]);
        pod
    }

    #[test]
    fn drain_keeps_daemon_and_static_pods() {
        assert!(matches!(classify(&owned_by("DaemonSet")), Class::Keep));
        assert!(matches!(classify(&owned_by("ReplicaSet")), Class::Evict));
        assert!(matches!(classify(&Pod::default()), Class::Unmanaged));

        let mut mirror = Pod::default();
        mirror.metadata.annotations =
            Some([("kubernetes.io/config.mirror".to_owned(), "x".to_owned())].into());
        assert!(matches!(classify(&mirror), Class::Keep));
    }
}
