use kube::{
    Api, ResourceExt,
    api::{DeleteParams, DynamicObject, GroupVersionKind, Patch, PatchParams, PostParams},
    discovery::{Scope, pinned_kind},
};
use serde_json::json;
use tauri::State;

use crate::{
    clients::Clients,
    kubeconfig::KubeconfigSources,
    resources::{Resolved, resolve},
};

/// The API for one object's kind, scoped to its namespace.
async fn object_api(
    sources: &KubeconfigSources,
    clients: &Clients,
    context: &str,
    kind: &str,
    namespace: Option<&str>,
) -> Result<(Api<DynamicObject>, Resolved), String> {
    let client = clients.get(sources, context).await?;
    let kind = resolve(&client, kind).await?;
    Ok((kind.api(client, namespace), kind))
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
    let (api, kind) = object_api(&sources, &clients, &context, &kind, namespace.as_deref()).await?;
    if !kind.restartable {
        return Err(format!("{} cannot be restarted", kind.id));
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
    let (api, kind) = object_api(&sources, &clients, &context, &kind, namespace.as_deref()).await?;
    if !kind.scalable {
        return Err(format!("{} cannot be scaled", kind.id));
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

/// Creates every object in a YAML text, `---` separated, like `kubectl
/// create -f`. Objects without a namespace go to `namespace`, else `default`.
/// Returns `kind/name` for each one created; stops at the first failure.
#[tauri::command]
pub async fn create_resources(
    context: String,
    namespace: Option<String>,
    yaml: String,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<Vec<String>, String> {
    let client = clients.get(&sources, &context).await?;
    let documents = split_documents(&yaml);
    if documents.is_empty() {
        return Err("There is nothing to create".into());
    }
    let mut created = Vec::new();
    for (index, document) in documents.iter().enumerate() {
        let fail = |e: String| {
            let done = match created.len() {
                0 => String::new(),
                _ => format!(" (created so far: {})", created.join(", ")),
            };
            let at = match documents.len() {
                1 => String::new(),
                _ => format!("Document {}: ", index + 1),
            };
            format!("{at}{e}{done}")
        };
        let object: DynamicObject =
            serde_saphyr::from_str(document).map_err(|e| fail(format!("Invalid YAML: {e}")))?;
        let types = object
            .types
            .as_ref()
            .ok_or_else(|| fail("apiVersion and kind are required".into()))?;
        let (group, version) = match types.api_version.split_once('/') {
            Some((group, version)) => (group, version),
            None => ("", types.api_version.as_str()),
        };
        let gvk = GroupVersionKind::gvk(group, version, &types.kind);
        let (resource, capabilities) = pinned_kind(&client, &gvk)
            .await
            .map_err(|e| fail(e.to_string()))?;
        let api: Api<DynamicObject> = match capabilities.scope {
            Scope::Namespaced => {
                let ns = object
                    .namespace()
                    .or_else(|| namespace.clone())
                    .unwrap_or_else(|| "default".into());
                Api::namespaced_with(client.clone(), &ns, &resource)
            }
            Scope::Cluster => Api::all_with(client.clone(), &resource),
        };
        let stored = api
            .create(&PostParams::default(), &object)
            .await
            .map_err(|e| fail(e.to_string()))?;
        created.push(format!(
            "{}/{}",
            types.kind.to_lowercase(),
            stored.name_any()
        ));
    }
    Ok(created)
}

/// Splits a multi-document YAML text, dropping documents with no content.
fn split_documents(yaml: &str) -> Vec<String> {
    let mut documents = vec![String::new()];
    for line in yaml.lines() {
        if line.trim_end() == "---" {
            documents.push(String::new());
        } else {
            let current = documents.last_mut().unwrap();
            current.push_str(line);
            current.push('\n');
        }
    }
    documents.retain(|d| {
        d.lines()
            .any(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
    });
    documents
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documents_split_on_separators() {
        let yaml = "---\n# comment only\n---\nkind: A\n---\nkind: B\n...\n";
        let docs = split_documents(yaml);
        assert_eq!(docs.len(), 2);
        assert!(docs[0].contains("kind: A") && docs[1].contains("kind: B"));
    }

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
