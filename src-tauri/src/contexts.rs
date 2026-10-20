use k8s_openapi::api::core::v1::Namespace;
use kube::{
    Api, ResourceExt,
    api::ListParams,
    config::Kubeconfig,
};
use serde::Serialize;
use tauri::State;

use crate::clients::Clients;

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
}

#[tauri::command]
pub fn list_contexts() -> Result<ContextList, String> {
    let kubeconfig = Kubeconfig::read().map_err(|e| e.to_string())?;
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

    Ok(ContextList {
        current: kubeconfig.current_context,
        contexts,
    })
}

#[tauri::command]
pub async fn list_namespaces(
    context: String,
    clients: State<'_, Clients>,
) -> Result<Vec<String>, String> {
    let client = clients.get(&context).await?;
    let namespaces = Api::<Namespace>::all(client)
        .list(&ListParams::default())
        .await
        .map_err(|e| e.to_string())?;

    let mut names: Vec<String> = namespaces.iter().map(|ns| ns.name_any()).collect();
    names.sort();
    Ok(names)
}
