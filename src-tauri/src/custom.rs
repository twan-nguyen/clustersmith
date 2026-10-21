use std::borrow::Cow;

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::{
    CustomResourceDefinition, CustomResourceDefinitionVersion,
};
use kube::{
    Api, Client,
    api::{ApiResource, DynamicObject, GroupVersionKind, ListParams},
};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{
    clients::Clients,
    kubeconfig::KubeconfigSources,
    resources::{Cells, FAILED, OK, PENDING, Resolved, Tone, list, text},
};

/// Custom kinds are addressed as `crd:<definition name>`, for example
/// `crd:certificates.cert-manager.io`, so they never clash with built-ins.
pub const PREFIX: &str = "crd:";

/// A printer column, shaped like a built-in kind's column.
#[derive(Serialize)]
pub struct Column {
    label: String,
    /// A `date` column, which the UI shows as an age.
    time: bool,
}

/// A custom resource as the sidebar lists it; shaped like a built-in kind.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomKind {
    id: String,
    label: String,
    singular: String,
    section: &'static str,
    /// The API group, which the sidebar groups custom kinds by.
    group: String,
    version: String,
    namespaced: bool,
    columns: Vec<Column>,
    age_label: &'static str,
    restartable: bool,
    scalable: bool,
}

/// The version clients should use: the stored one when it is served.
fn served_version(crd: &CustomResourceDefinition) -> Option<&CustomResourceDefinitionVersion> {
    let versions = &crd.spec.versions;
    versions
        .iter()
        .find(|v| v.served && v.storage)
        .or_else(|| versions.iter().find(|v| v.served))
}

/// The columns `kubectl get` shows by default, minus the age it adds anyway.
fn printer_columns(version: &CustomResourceDefinitionVersion) -> Vec<(Column, String)> {
    version
        .additional_printer_columns
        .iter()
        .flatten()
        .filter(|c| c.priority.unwrap_or(0) == 0 && c.json_path != ".metadata.creationTimestamp")
        .map(|c| {
            let column = Column {
                label: c.name.clone(),
                time: c.type_ == "date",
            };
            (column, c.json_path.clone())
        })
        .collect()
}

#[tauri::command]
pub async fn list_custom_kinds(
    context: String,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<Vec<CustomKind>, String> {
    let client = clients.get(&sources, &context).await?;
    let crds = Api::<CustomResourceDefinition>::all(client)
        .list(&ListParams::default())
        .await
        .map_err(|e| e.to_string())?;
    let mut kinds: Vec<CustomKind> = crds
        .items
        .iter()
        .filter_map(|crd| {
            let version = served_version(crd)?;
            let names = &crd.spec.names;
            Some(CustomKind {
                id: format!("{PREFIX}{}.{}", names.plural, crd.spec.group),
                label: names.kind.clone(),
                singular: names.kind.clone(),
                section: "Custom Resources",
                group: crd.spec.group.clone(),
                version: version.name.clone(),
                namespaced: crd.spec.scope == "Namespaced",
                columns: printer_columns(version)
                    .into_iter()
                    .map(|(c, _)| c)
                    .collect(),
                age_label: "Age",
                restartable: false,
                scalable: false,
            })
        })
        .collect();
    kinds.sort_by(|a, b| (&a.group, &a.label).cmp(&(&b.group, &b.label)));
    Ok(kinds)
}

pub async fn resolve(client: &Client, name: &str) -> Result<Resolved, String> {
    let crd = Api::<CustomResourceDefinition>::all(client.clone())
        .get(name)
        .await
        .map_err(|e| e.to_string())?;
    let version = served_version(&crd).ok_or_else(|| format!("{name} serves no version"))?;
    let names = &crd.spec.names;
    let gvk = GroupVersionKind::gvk(&crd.spec.group, &version.name, &names.kind);
    Ok(Resolved {
        id: format!("{PREFIX}{name}"),
        resource: ApiResource::from_gvk_with_plural(&gvk, &names.plural),
        namespaced: crd.spec.scope == "Namespaced",
        restartable: false,
        scalable: false,
        cells: Cells::Printer(
            printer_columns(version)
                .into_iter()
                .map(|(_, p)| p)
                .collect(),
        ),
    })
}

/// Cells from printer column paths, toned by a `Ready` condition if any.
pub fn printer_row(paths: &[String], object: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let metadata = || serde_json::json!({ "metadata": object.metadata });
    let cells = paths
        .iter()
        .map(|path| {
            // Only metadata lives outside `data`; serialize it only when asked for.
            let root = if path.trim_start_matches('{').starts_with(".metadata") {
                Cow::Owned(metadata())
            } else {
                Cow::Borrowed(&object.data)
            };
            render(&root, path)
        })
        .collect();
    let ready = list(&object.data, &["status", "conditions"])
        .iter()
        .find(|c| c["type"] == "Ready")
        .map(|c| match text(c, &["status"]).as_str() {
            "True" => OK,
            "False" => FAILED,
            _ => PENDING,
        });
    (cells, ready)
}

/// A printer column's value as `kubectl` prints it: matches joined by commas.
fn render(root: &Value, path: &str) -> String {
    json_path(root, path)
        .into_iter()
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// The JSONPath subset printer columns use: `.field`, `['field']`, `[0]`,
/// `[*]` and filters like `[?(@.type=="Ready")]`.
pub fn json_path<'a>(root: &'a Value, path: &str) -> Vec<&'a Value> {
    let mut rest = path.trim().trim_start_matches('{').trim_end_matches('}');
    rest = rest.strip_prefix('$').unwrap_or(rest);
    let mut current = vec![root];

    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('.') {
            // A backslash keeps a dot in the name, as in label keys.
            let mut field = String::new();
            let mut chars = after.char_indices().peekable();
            let mut end = after.len();
            while let Some((i, c)) = chars.next() {
                match c {
                    '\\' => field.extend(chars.next().map(|(_, c)| c)),
                    '.' | '[' => {
                        end = i;
                        break;
                    }
                    c => field.push(c),
                }
            }
            rest = &after[end..];
            if !field.is_empty() {
                current = current.into_iter().filter_map(|v| v.get(&field)).collect();
            }
        } else if let Some(after) = rest.strip_prefix('[') {
            let Some(end) = after.find(']') else { break };
            let inner = after[..end].trim();
            rest = &after[end + 1..];
            current = current.into_iter().flat_map(|v| select(v, inner)).collect();
        } else {
            break;
        }
    }
    current
}

/// What one bracket selects from a value.
fn select<'a>(value: &'a Value, inner: &str) -> Vec<&'a Value> {
    let items = || value.as_array().map_or(&[][..], Vec::as_slice);
    if inner == "*" {
        return match value {
            Value::Object(map) => map.values().collect(),
            _ => items().iter().collect(),
        };
    }
    if let Ok(index) = inner.parse::<i64>() {
        let len = items().len() as i64;
        let index = if index < 0 { len + index } else { index };
        return usize::try_from(index)
            .ok()
            .and_then(|i| items().get(i))
            .into_iter()
            .collect();
    }
    if let Some(filter) = inner.strip_prefix("?(").and_then(|f| f.strip_suffix(')')) {
        let (negate, (left, right)) = match filter.split_once("!=") {
            Some(parts) => (true, parts),
            None => match filter.split_once("==") {
                Some(parts) => (false, parts),
                None => return vec![],
            },
        };
        let field = left.trim().trim_start_matches('@');
        let wanted = right.trim().trim_matches(['"', '\'']);
        return items()
            .iter()
            .filter(|item| {
                let found = json_path(item, field)
                    .iter()
                    .any(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned) == wanted);
                found != negate
            })
            .collect();
    }
    let field = inner.trim_matches(['"', '\'']);
    value.get(field).into_iter().collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn json_path_reads_printer_columns() {
        let object = json!({
            "spec": { "secretName": "tls", "dnsNames": ["a.com", "b.com"] },
            "status": { "conditions": [
                { "type": "Issuing", "status": "False" },
                { "type": "Ready", "status": "True", "message": "ok" }
            ] }
        });
        assert_eq!(render(&object, ".spec.secretName"), "tls");
        assert_eq!(render(&object, ".spec.dnsNames[*]"), "a.com,b.com");
        assert_eq!(render(&object, ".spec.dnsNames[-1]"), "b.com");
        assert_eq!(
            render(&object, r#".status.conditions[?(@.type=="Ready")].status"#),
            "True"
        );
        assert_eq!(
            render(&object, ".status.conditions[?(@.type!='Ready')].type"),
            "Issuing"
        );
        assert_eq!(render(&object, "{.spec['secretName']}"), "tls");
        assert_eq!(render(&object, ".spec.missing"), "");
        let labels = json!({ "metadata": { "labels": { "io.kubernetes.pod.namespace": "web" } } });
        assert_eq!(
            render(&labels, r".metadata.labels.io\.kubernetes\.pod\.namespace"),
            "web"
        );
    }

    #[test]
    fn printer_row_reads_metadata_and_ready() {
        let resource = ApiResource::from_gvk(&GroupVersionKind::gvk("x.io", "v1", "Thing"));
        let mut object = DynamicObject::new("thing", &resource);
        object.metadata.labels = Some([("app".to_owned(), "web".to_owned())].into());
        object.data =
            json!({ "status": { "conditions": [{ "type": "Ready", "status": "False" }] } });
        let paths = [".metadata.labels.app".to_owned()];
        assert_eq!(
            printer_row(&paths, &object),
            (vec!["web".into()], Some(FAILED))
        );
    }
}
