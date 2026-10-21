use kube::{
    Api,
    api::{DeleteParams, DynamicObject, Patch, PatchParams, PostParams},
};
use serde_json::json;
use tauri::State;

use crate::{
    clients::Clients,
    kubeconfig::KubeconfigSources,
    resources::{KindSpec, find},
};

/// The API for one object's kind, scoped to its namespace.
async fn object_api(
    sources: &KubeconfigSources,
    clients: &Clients,
    context: &str,
    kind: &str,
    namespace: Option<&str>,
) -> Result<(Api<DynamicObject>, &'static KindSpec), String> {
    let spec = find(kind)?;
    let client = clients.get(sources, context).await?;
    Ok((spec.api(client, namespace), spec))
}

#[tauri::command]
pub async fn delete_resource(
    context: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<(), String> {
    let (api, _) = object_api(&sources, &clients, &context, &kind, namespace.as_deref()).await?;
    api.delete(&name, &DeleteParams::default())
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// What `kubectl rollout restart` does: a new pod template annotation makes
/// the controller replace every pod.
#[tauri::command]
pub async fn restart_workload(
    context: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<(), String> {
    let (api, spec) = object_api(&sources, &clients, &context, &kind, namespace.as_deref()).await?;
    if !spec.restartable {
        return Err(format!("{} cannot be restarted", spec.id));
    }
    let now = jiff::Timestamp::now().to_string();
    let patch = json!({
        "spec": { "template": { "metadata": { "annotations": {
            "kubectl.kubernetes.io/restartedAt": now
        } } } }
    });
    api.patch(&name, &PatchParams::default(), &Patch::Merge(patch))
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scale_workload(
    context: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    replicas: u32,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<(), String> {
    let (api, spec) = object_api(&sources, &clients, &context, &kind, namespace.as_deref()).await?;
    if !spec.scalable {
        return Err(format!("{} cannot be scaled", spec.id));
    }
    let patch = json!({ "spec": { "replicas": replicas } });
    api.patch(&name, &PatchParams::default(), &Patch::Merge(patch))
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The object as YAML, without the server-side bookkeeping nobody edits by hand.
fn to_yaml(mut object: DynamicObject) -> Result<String, String> {
    object.metadata.managed_fields = None;
    serde_saphyr::to_string(&object).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_resource_yaml(
    context: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<String, String> {
    let (api, _) = object_api(&sources, &clients, &context, &kind, namespace.as_deref()).await?;
    let object = api.get(&name).await.map_err(|e| e.to_string())?;
    to_yaml(object)
}

/// Replaces the object with the edited YAML and returns what the server
/// stored. The YAML carries the `resourceVersion` it was read at, so an edit
/// made meanwhile by someone else is rejected instead of overwritten.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn apply_resource_yaml(
    context: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    yaml: String,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<String, String> {
    let (api, _) = object_api(&sources, &clients, &context, &kind, namespace.as_deref()).await?;
    let object: DynamicObject =
        serde_saphyr::from_str(&yaml).map_err(|e| format!("Invalid YAML: {e}"))?;
    if object.metadata.name.as_deref() != Some(name.as_str()) {
        return Err(format!("metadata.name must stay \"{name}\""));
    }
    let stored = api
        .replace(&name, &PostParams::default(), &object)
        .await
        .map_err(|e| e.to_string())?;
    to_yaml(stored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaml_round_trips_without_managed_fields() {
        let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: default\n  managedFields:\n  - manager: kubectl\ndata:\n  key: value\n";
        let object: DynamicObject = serde_saphyr::from_str(yaml).unwrap();
        let out = to_yaml(object).unwrap();
        assert!(!out.contains("managedFields"));
        let back: DynamicObject = serde_saphyr::from_str(&out).unwrap();
        assert_eq!(back.metadata.name.as_deref(), Some("app"));
        assert_eq!(back.data["data"]["key"], "value");
    }
}
