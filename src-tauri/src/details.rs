use k8s_openapi::api::core::v1::Pod;
use kube::{
    Api, Client, ResourceExt,
    api::{DynamicObject, ListParams},
};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{
    clients::Clients,
    kubeconfig::KubeconfigSources,
    pods::{PodRow, pod_row},
    resources::{Resolved, find, last_seen, list, resolve, text},
};

/// Everything the details panel shows for one object.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    /// The object as the API returns it, without managed fields.
    object: Value,
    /// Newest first.
    events: Vec<EventRow>,
    /// Pods the object selects or runs; `None` for kinds without pods.
    pods: Option<Vec<PodRow>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    /// `Normal` or `Warning`.
    kind: String,
    reason: String,
    message: String,
    count: i64,
    last_seen: Option<String>,
}

#[tauri::command]
pub async fn describe_resource(
    context: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<Details, String> {
    let client = clients.get(&sources, &context).await?;
    let kind = resolve(&client, &kind).await?;
    let mut object = kind
        .api(client.clone(), namespace.as_deref())
        .get(&name)
        .await
        .map_err(|e| e.to_string())?;
    object.metadata.managed_fields = None;

    // Both are extras: a missing permission leaves them empty, not the panel.
    let (events, pods) = tokio::join!(
        events_for(&client, &object),
        pods_of(&client, &kind.id, &object)
    );
    let pods = pods
        .ok()
        .flatten()
        .map(|pods| pods.iter().map(pod_row).collect());
    let object = serde_json::to_value(&object).map_err(|e| e.to_string())?;
    Ok(Details {
        object,
        events,
        pods,
    })
}

async fn events_for(client: &Client, object: &DynamicObject) -> Vec<EventRow> {
    let Some(uid) = object.uid() else {
        return vec![];
    };
    let Ok(spec) = find("events") else {
        return vec![];
    };
    let api = Resolved::from(spec).api(client.clone(), None);
    let params = ListParams::default().fields(&format!("involvedObject.uid={uid}"));
    let Ok(events) = api.list(&params).await else {
        return vec![];
    };
    let mut rows: Vec<EventRow> = events
        .items
        .iter()
        .map(|e| {
            let d = &e.data;
            EventRow {
                kind: text(d, &["type"]),
                reason: text(d, &["reason"]),
                message: text(d, &["message"]).trim().to_owned(),
                count: d["count"]
                    .as_i64()
                    .or_else(|| d["series"]["count"].as_i64())
                    .unwrap_or(1),
                last_seen: last_seen(d),
            }
        })
        .collect();
    rows.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    rows
}

/// How to find the pods an object owns or routes to.
enum PodQuery {
    Labels(String),
    /// Pods scheduled on a node, in every namespace.
    Node(String),
}

fn pod_query(kind: &str, object: &DynamicObject) -> Option<PodQuery> {
    let spec = &object.data["spec"];
    match kind {
        "deployments" | "statefulsets" | "daemonsets" | "replicasets" | "jobs" => {
            label_selector(&spec["selector"]).map(PodQuery::Labels)
        }
        // A service selects by plain labels, without `matchLabels`.
        "services" => label_selector(&serde_json::json!({ "matchLabels": spec["selector"] }))
            .map(PodQuery::Labels),
        "nodes" => Some(PodQuery::Node(object.name_any())),
        _ => None,
    }
}

/// A `LabelSelector` written as `kubectl -l` takes it. An empty selector
/// would match every pod, so it reads as none.
pub fn label_selector(selector: &Value) -> Option<String> {
    let mut parts: Vec<String> = selector["matchLabels"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default()))
        .collect();
    for expr in list(selector, &["matchExpressions"]) {
        let key = text(expr, &["key"]);
        let values = list(expr, &["values"])
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(",");
        parts.push(match text(expr, &["operator"]).as_str() {
            "In" => format!("{key} in ({values})"),
            "NotIn" => format!("{key} notin ({values})"),
            "Exists" => key,
            "DoesNotExist" => format!("!{key}"),
            _ => continue,
        });
    }
    (!parts.is_empty()).then(|| parts.join(","))
}

/// The pods behind a workload, service or node; `None` for other kinds.
pub async fn pods_of(
    client: &Client,
    kind: &str,
    object: &DynamicObject,
) -> Result<Option<Vec<Pod>>, String> {
    let Some(query) = pod_query(kind, object) else {
        return Ok(None);
    };
    let (api, params) = match query {
        PodQuery::Labels(labels) => {
            let ns = object.namespace().unwrap_or_default();
            let api: Api<Pod> = Api::namespaced(client.clone(), &ns);
            (api, ListParams::default().labels(&labels))
        }
        PodQuery::Node(node) => (
            Api::all(client.clone()),
            ListParams::default().fields(&format!("spec.nodeName={node}")),
        ),
    };
    let mut pods = api.list(&params).await.map_err(|e| e.to_string())?.items;
    pods.sort_by_key(|p| (p.namespace(), p.name_any()));
    Ok(Some(pods))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn selector_covers_labels_and_expressions() {
        let selector = json!({
            "matchLabels": { "app": "web" },
            "matchExpressions": [
                { "key": "tier", "operator": "In", "values": ["api", "edge"] },
                { "key": "canary", "operator": "DoesNotExist" }
            ]
        });
        assert_eq!(
            label_selector(&selector).as_deref(),
            Some("app=web,tier in (api,edge),!canary")
        );
        assert_eq!(label_selector(&json!({})), None);
    }
}
