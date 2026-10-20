use std::path::PathBuf;

use k8s_openapi::api::core::v1::Namespace;
use kube::{Api, ResourceExt, api::ListParams};
use serde::Serialize;
use tauri::State;

use crate::{
    clients::Clients,
    kubeconfig::{KubeconfigSources, SourceStatus},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeContext {
    name: String,
    cluster: String,
    namespace: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextList {
    current: Option<String>,
    contexts: Vec<KubeContext>,
    sources: Vec<SourceStatus>,
}

fn context_list(sources: &KubeconfigSources) -> ContextList {
    let (kubeconfig, statuses) = sources.read();
    let contexts = kubeconfig
        .contexts
        .into_iter()
        .map(|named| {
            let context = named.context.unwrap_or_default();
            KubeContext {
                name: named.name,
                cluster: context.cluster,
                namespace: context.namespace,
            }
        })
        .collect();

    ContextList {
        current: kubeconfig.current_context,
        contexts,
        sources: statuses,
    }
}

#[tauri::command]
pub fn list_contexts(sources: State<'_, KubeconfigSources>) -> ContextList {
    context_list(&sources)
}

#[tauri::command]
pub fn add_kubeconfig(
    path: PathBuf,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<ContextList, String> {
    sources.add(path)?;
    clients.clear();
    Ok(context_list(&sources))
}

#[tauri::command]
pub fn remove_kubeconfig(
    path: PathBuf,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<ContextList, String> {
    sources.remove(&path)?;
    clients.clear();
    Ok(context_list(&sources))
}

#[tauri::command]
pub async fn list_namespaces(
    context: String,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<Vec<String>, String> {
    let client = clients.get(&sources, &context).await?;
    let namespaces = Api::<Namespace>::all(client)
        .list(&ListParams::default())
        .await
        .map_err(|e| e.to_string())?;

    let mut names: Vec<String> = namespaces.iter().map(|ns| ns.name_any()).collect();
    names.sort();
    Ok(names)
}
