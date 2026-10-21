use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::Node;
use kube::{
    Api, ResourceExt,
    api::{ApiResource, DynamicObject, GroupVersionKind, ListParams},
};
use serde::Serialize;
use tauri::State;

use crate::{clients::Clients, kubeconfig::KubeconfigSources, resources::list};

/// Current usage from metrics-server, with what a node can give when known.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Cores.
    cpu: f64,
    /// Bytes.
    memory: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu_allocatable: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_allocatable: Option<f64>,
}

/// Usage per pod (`namespace/name`) or node (`name`). `None` means the
/// cluster has no metrics API, so the UI leaves the columns out.
#[tauri::command]
pub async fn get_metrics(
    context: String,
    kind: String,
    namespace: Option<String>,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<Option<BTreeMap<String, Usage>>, String> {
    let client = clients.get(&sources, &context).await?;
    let (api_kind, nodes) = match kind.as_str() {
        "pods" => ("PodMetrics", false),
        "nodes" => ("NodeMetrics", true),
        other => return Err(format!("no metrics for {other}")),
    };
    let gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", api_kind);
    let resource = ApiResource::from_gvk_with_plural(&gvk, &kind);
    let api: Api<DynamicObject> = match namespace.as_deref().filter(|_| !nodes) {
        Some(ns) => Api::namespaced_with(client.clone(), ns, &resource),
        None => Api::all_with(client.clone(), &resource),
    };
    let items = match api.list(&ListParams::default()).await {
        Ok(list) => list.items,
        // Not installed (404) or not running (503): no metrics, not an error.
        Err(kube::Error::Api(status)) if matches!(status.code, 404 | 503) => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };

    let mut usage: BTreeMap<String, Usage> = items
        .iter()
        .map(|item| {
            let key = match item.namespace() {
                Some(ns) => format!("{ns}/{}", item.name_any()),
                None => item.name_any(),
            };
            // A pod reports per container; a node reports once.
            let parts = if nodes {
                vec![&item.data["usage"]]
            } else {
                list(&item.data, &["containers"])
                    .iter()
                    .map(|c| &c["usage"])
                    .collect()
            };
            let sum = |resource: &str| {
                parts
                    .iter()
                    .filter_map(|u| u[resource].as_str().and_then(parse_quantity))
                    .sum()
            };
            let usage = Usage {
                cpu: sum("cpu"),
                memory: sum("memory"),
                ..Default::default()
            };
            (key, usage)
        })
        .collect();

    if nodes && let Ok(list) = Api::<Node>::all(client).list(&ListParams::default()).await {
        for node in list.items {
            let Some(entry) = usage.get_mut(&node.name_any()) else {
                continue;
            };
            let allocatable = node.status.and_then(|s| s.allocatable).unwrap_or_default();
            let read = |key: &str| allocatable.get(key).and_then(|q| parse_quantity(&q.0));
            entry.cpu_allocatable = read("cpu");
            entry.memory_allocatable = read("memory");
        }
    }
    Ok(Some(usage))
}

/// A Kubernetes quantity such as `250m`, `1.5`, `128Mi` or `123456n`, as a
/// plain number (cores or bytes).
pub fn parse_quantity(quantity: &str) -> Option<f64> {
    let quantity = quantity.trim();
    let split = quantity
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+'))
        .unwrap_or(quantity.len());
    let (number, suffix) = quantity.split_at(split);
    let number: f64 = number.parse().ok()?;
    let scale = match suffix {
        "" => 1.0,
        "n" => 1e-9,
        "u" => 1e-6,
        "m" => 1e-3,
        "k" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "P" => 1e15,
        "E" => 1e18,
        "Ki" => 1024.0,
        "Mi" => 1024f64.powi(2),
        "Gi" => 1024f64.powi(3),
        "Ti" => 1024f64.powi(4),
        "Pi" => 1024f64.powi(5),
        "Ei" => 1024f64.powi(6),
        exponent => {
            let power: i32 = exponent.strip_prefix(['e', 'E'])?.parse().ok()?;
            10f64.powi(power)
        }
    };
    Some(number * scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantities_parse_to_cores_and_bytes() {
        assert_eq!(parse_quantity("250m"), Some(0.25));
        assert_eq!(parse_quantity("2"), Some(2.0));
        assert_eq!(parse_quantity("1500000n"), Some(0.0015));
        assert_eq!(parse_quantity("128Mi"), Some(128.0 * 1024.0 * 1024.0));
        assert_eq!(parse_quantity("1G"), Some(1e9));
        assert_eq!(parse_quantity("1e3"), Some(1000.0));
        assert_eq!(parse_quantity("lots"), None);
    }
}
