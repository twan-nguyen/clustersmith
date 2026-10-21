use kube::{
    Api, Client, ResourceExt,
    api::{ApiResource, DynamicObject, GroupVersionKind},
};
use serde::Serialize;
use serde_json::Value;
use tauri::{State, ipc::Channel};

use crate::{
    clients::Clients,
    kubeconfig::KubeconfigSources,
    watch::{ViewWatch, WatchEvent, run_watch},
};

/// A row color, matching the UI's status icons.
type Tone = &'static str;
const OK: Tone = "ok";
const DONE: Tone = "done";
const PENDING: Tone = "pending";
const FAILED: Tone = "failed";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    label: &'static str,
    /// The cell holds an RFC 3339 time that the UI shows as an age.
    time: bool,
}

const fn col(label: &'static str) -> Column {
    Column { label, time: false }
}

const fn time_col(label: &'static str) -> Column {
    Column { label, time: true }
}

/// One kind of object the sidebar lists, with the columns `kubectl get` shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindSpec {
    pub id: &'static str,
    label: &'static str,
    section: &'static str,
    #[serde(skip)]
    group: &'static str,
    #[serde(skip)]
    version: &'static str,
    /// The API kind, such as `Deployment`; the UI uses it as the singular name.
    #[serde(rename = "singular")]
    kind: &'static str,
    namespaced: bool,
    columns: &'static [Column],
    age_label: &'static str,
    pub restartable: bool,
    pub scalable: bool,
    #[serde(skip)]
    row: fn(&DynamicObject) -> (Vec<String>, Option<Tone>),
}

impl KindSpec {
    fn api_resource(&self) -> ApiResource {
        let gvk = GroupVersionKind::gvk(self.group, self.version, self.kind);
        ApiResource::from_gvk_with_plural(&gvk, self.id)
    }

    /// Scoped to `namespace` when given and the kind lives in namespaces.
    pub fn api(&self, client: Client, namespace: Option<&str>) -> Api<DynamicObject> {
        let resource = self.api_resource();
        match namespace.filter(|_| self.namespaced) {
            Some(ns) => Api::namespaced_with(client, ns, &resource),
            None => Api::all_with(client, &resource),
        }
    }
}

const fn kind(
    id: &'static str,
    label: &'static str,
    section: &'static str,
    (group, version, kind): (&'static str, &'static str, &'static str),
    namespaced: bool,
    columns: &'static [Column],
    row: fn(&DynamicObject) -> (Vec<String>, Option<Tone>),
) -> KindSpec {
    KindSpec {
        id,
        label,
        section,
        group,
        version,
        kind,
        namespaced,
        columns,
        age_label: "Age",
        restartable: false,
        scalable: false,
        row,
    }
}

/// Every kind the sidebar shows, in order. The `id` is the API's plural name.
static KINDS: &[KindSpec] = &[
    // Pods have their own view and watch; the entry gives them a sidebar place
    // and lets delete and YAML treat them like everything else.
    kind(
        "pods",
        "Pods",
        "Workloads",
        ("", "v1", "Pod"),
        true,
        &[],
        |_| (vec![], None),
    ),
    KindSpec {
        restartable: true,
        scalable: true,
        ..kind(
            "deployments",
            "Deployments",
            "Workloads",
            ("apps", "v1", "Deployment"),
            true,
            &[col("Ready"), col("Up-to-date"), col("Available")],
            deployment,
        )
    },
    KindSpec {
        restartable: true,
        scalable: true,
        ..kind(
            "statefulsets",
            "StatefulSets",
            "Workloads",
            ("apps", "v1", "StatefulSet"),
            true,
            &[col("Ready")],
            stateful_set,
        )
    },
    KindSpec {
        restartable: true,
        ..kind(
            "daemonsets",
            "DaemonSets",
            "Workloads",
            ("apps", "v1", "DaemonSet"),
            true,
            &[
                col("Desired"),
                col("Current"),
                col("Ready"),
                col("Up-to-date"),
                col("Available"),
            ],
            daemon_set,
        )
    },
    kind(
        "jobs",
        "Jobs",
        "Workloads",
        ("batch", "v1", "Job"),
        true,
        &[col("Completions"), col("Status")],
        job,
    ),
    kind(
        "cronjobs",
        "CronJobs",
        "Workloads",
        ("batch", "v1", "CronJob"),
        true,
        &[
            col("Schedule"),
            col("Suspend"),
            col("Active"),
            time_col("Last schedule"),
        ],
        cron_job,
    ),
    kind(
        "services",
        "Services",
        "Network",
        ("", "v1", "Service"),
        true,
        &[
            col("Type"),
            col("Cluster IP"),
            col("External IP"),
            col("Ports"),
        ],
        service,
    ),
    kind(
        "ingresses",
        "Ingresses",
        "Network",
        ("networking.k8s.io", "v1", "Ingress"),
        true,
        &[col("Class"), col("Hosts"), col("Address")],
        ingress,
    ),
    kind(
        "configmaps",
        "ConfigMaps",
        "Config",
        ("", "v1", "ConfigMap"),
        true,
        &[col("Data")],
        config_map,
    ),
    kind(
        "secrets",
        "Secrets",
        "Config",
        ("", "v1", "Secret"),
        true,
        &[col("Type"), col("Data")],
        secret,
    ),
    kind(
        "nodes",
        "Nodes",
        "Cluster",
        ("", "v1", "Node"),
        false,
        &[
            col("Status"),
            col("Roles"),
            col("Version"),
            col("Internal IP"),
        ],
        node,
    ),
    kind(
        "namespaces",
        "Namespaces",
        "Cluster",
        ("", "v1", "Namespace"),
        false,
        &[col("Status")],
        namespace,
    ),
    KindSpec {
        age_label: "Last seen",
        ..kind(
            "events",
            "Events",
            "Cluster",
            ("", "v1", "Event"),
            true,
            &[
                col("Type"),
                col("Reason"),
                col("Object"),
                col("Message"),
                col("Count"),
            ],
            event,
        )
    },
];

pub fn find(id: &str) -> Result<&'static KindSpec, String> {
    KINDS
        .iter()
        .find(|k| k.id == id)
        .ok_or_else(|| format!("Unknown resource kind: {id}"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRow {
    uid: String,
    name: String,
    namespace: Option<String>,
    cells: Vec<String>,
    tone: Option<Tone>,
    /// RFC 3339; the creation time, or the last occurrence for events.
    age: Option<String>,
}

fn resource_row(spec: &KindSpec, object: &DynamicObject) -> ResourceRow {
    let (cells, tone) = (spec.row)(object);
    let created = || {
        object
            .metadata
            .creation_timestamp
            .as_ref()
            .map(|t| t.0.to_string())
    };
    let age = if spec.id == "events" {
        last_seen(&object.data).or_else(created)
    } else {
        created()
    };
    ResourceRow {
        uid: object.uid().unwrap_or_default(),
        name: object.name_any(),
        namespace: object.namespace(),
        cells,
        tone,
        age,
    }
}

#[tauri::command]
pub fn list_resource_kinds() -> &'static [KindSpec] {
    KINDS
}

#[tauri::command]
pub async fn watch_resources(
    context: String,
    kind: String,
    namespace: Option<String>,
    on_event: Channel<WatchEvent<ResourceRow>>,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
    watch: State<'_, ViewWatch>,
) -> Result<(), String> {
    let spec = find(&kind)?;
    let generation = watch.begin();
    let client = clients.get(&sources, &context).await?;
    let api = spec.api(client, namespace.as_deref());
    let rows = move |object: &DynamicObject| resource_row(spec, object);
    watch.start(
        generation,
        run_watch(api, spec.api_resource(), on_event, rows),
    );
    Ok(())
}

// Field access over the untyped object. Missing fields read as empty or zero.

fn at<'a>(value: &'a Value, path: &[&str]) -> &'a Value {
    path.iter().fold(value, |v, key| &v[*key])
}

fn text(value: &Value, path: &[&str]) -> String {
    match at(value, path) {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn int(value: &Value, path: &[&str]) -> i64 {
    at(value, path).as_i64().unwrap_or(0)
}

fn list<'a>(value: &'a Value, path: &[&str]) -> &'a [Value] {
    at(value, path).as_array().map_or(&[], Vec::as_slice)
}

fn count_keys(value: &Value, path: &[&str]) -> usize {
    at(value, path).as_object().map_or(0, |m| m.len())
}

/// `kubectl` prints `<none>` for empty cells; a dash reads quieter.
fn or_dash(s: String) -> String {
    if s.is_empty() { "—".into() } else { s }
}

fn replicas_tone(ready: i64, desired: i64) -> Tone {
    if desired == 0 {
        DONE
    } else if ready >= desired {
        OK
    } else {
        PENDING
    }
}

fn deployment(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let desired = int(d, &["spec", "replicas"]);
    let ready = int(d, &["status", "readyReplicas"]);
    let cells = vec![
        format!("{ready}/{desired}"),
        int(d, &["status", "updatedReplicas"]).to_string(),
        int(d, &["status", "availableReplicas"]).to_string(),
    ];
    (cells, Some(replicas_tone(ready, desired)))
}

fn stateful_set(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let desired = int(d, &["spec", "replicas"]);
    let ready = int(d, &["status", "readyReplicas"]);
    (
        vec![format!("{ready}/{desired}")],
        Some(replicas_tone(ready, desired)),
    )
}

fn daemon_set(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let s = &o.data["status"];
    let desired = int(s, &["desiredNumberScheduled"]);
    let ready = int(s, &["numberReady"]);
    let cells = [
        "desiredNumberScheduled",
        "currentNumberScheduled",
        "numberReady",
        "updatedNumberScheduled",
        "numberAvailable",
    ]
    .iter()
    .map(|field| int(s, &[field]).to_string())
    .collect();
    (cells, Some(replicas_tone(ready, desired)))
}

fn job(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let completions = at(d, &["spec", "completions"]).as_i64().unwrap_or(1);
    let succeeded = int(d, &["status", "succeeded"]);
    let condition = |kind: &str| {
        list(d, &["status", "conditions"])
            .iter()
            .any(|c| c["type"] == kind && c["status"] == "True")
    };
    let (status, tone) = if condition("Complete") {
        ("Complete", DONE)
    } else if condition("Failed") {
        ("Failed", FAILED)
    } else if at(d, &["spec", "suspend"]) == true {
        ("Suspended", DONE)
    } else if int(d, &["status", "active"]) > 0 {
        ("Running", OK)
    } else {
        ("Pending", PENDING)
    };
    (
        vec![format!("{succeeded}/{completions}"), status.into()],
        Some(tone),
    )
}

fn cron_job(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let suspended = at(d, &["spec", "suspend"]) == true;
    let cells = vec![
        text(d, &["spec", "schedule"]),
        if suspended { "True" } else { "False" }.into(),
        list(d, &["status", "active"]).len().to_string(),
        text(d, &["status", "lastScheduleTime"]),
    ];
    (cells, Some(if suspended { DONE } else { OK }))
}

/// Load balancer ingress points, as IPs or host names.
fn lb_addresses(value: &Value) -> String {
    list(value, &["status", "loadBalancer", "ingress"])
        .iter()
        .map(|i| match text(i, &["ip"]) {
            ip if ip.is_empty() => text(i, &["hostname"]),
            ip => ip,
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn service(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let external = match lb_addresses(d) {
        s if s.is_empty() => list(d, &["spec", "externalIPs"])
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", "),
        s => s,
    };
    let ports = list(d, &["spec", "ports"])
        .iter()
        .map(|p| {
            let node_port = p["nodePort"]
                .as_i64()
                .map(|n| format!(":{n}"))
                .unwrap_or_default();
            format!(
                "{}{node_port}/{}",
                text(p, &["port"]),
                text(p, &["protocol"])
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let cells = vec![
        text(d, &["spec", "type"]),
        or_dash(text(d, &["spec", "clusterIP"])),
        or_dash(external),
        or_dash(ports),
    ];
    (cells, None)
}

fn ingress(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let hosts = list(d, &["spec", "rules"])
        .iter()
        .filter_map(|r| r["host"].as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let cells = vec![
        or_dash(text(d, &["spec", "ingressClassName"])),
        or_dash(hosts),
        or_dash(lb_addresses(d)),
    ];
    (cells, None)
}

fn config_map(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let keys = count_keys(&o.data, &["data"]) + count_keys(&o.data, &["binaryData"]);
    (vec![keys.to_string()], None)
}

fn secret(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let cells = vec![
        text(&o.data, &["type"]),
        count_keys(&o.data, &["data"]).to_string(),
    ];
    (cells, None)
}

fn node(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let ready = list(d, &["status", "conditions"])
        .iter()
        .any(|c| c["type"] == "Ready" && c["status"] == "True");
    let cordoned = at(d, &["spec", "unschedulable"]) == true;
    let (status, tone) = match (ready, cordoned) {
        (true, false) => ("Ready", OK),
        (true, true) => ("Ready, SchedulingDisabled", PENDING),
        (false, _) => ("NotReady", FAILED),
    };
    let roles = o
        .labels()
        .keys()
        .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/"))
        .collect::<Vec<_>>()
        .join(", ");
    let internal_ip = list(d, &["status", "addresses"])
        .iter()
        .find(|a| a["type"] == "InternalIP")
        .map(|a| text(a, &["address"]))
        .unwrap_or_default();
    let cells = vec![
        status.into(),
        or_dash(roles),
        text(d, &["status", "nodeInfo", "kubeletVersion"]),
        or_dash(internal_ip),
    ];
    (cells, Some(tone))
}

fn namespace(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let phase = text(&o.data, &["status", "phase"]);
    let tone = if phase == "Active" { OK } else { PENDING };
    (vec![phase], Some(tone))
}

fn event(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let kind = text(d, &["type"]);
    let object = format!(
        "{}/{}",
        text(d, &["involvedObject", "kind"]).to_lowercase(),
        text(d, &["involvedObject", "name"])
    );
    let count = at(d, &["count"])
        .as_i64()
        .or_else(|| at(d, &["series", "count"]).as_i64())
        .unwrap_or(1);
    let message = text(d, &["message"])
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_owned();
    let tone = (kind == "Warning").then_some(PENDING);
    let cells = vec![
        kind,
        text(d, &["reason"]),
        object,
        message,
        count.to_string(),
    ];
    (cells, tone)
}

/// When an event last happened; the field depends on which API wrote it.
fn last_seen(data: &Value) -> Option<String> {
    [
        &["series", "lastObservedTime"][..],
        &["lastTimestamp"],
        &["eventTime"],
    ]
    .iter()
    .map(|path| text(data, path))
    .find(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn object(data: Value) -> DynamicObject {
        let mut o = DynamicObject::new("x", &find("deployments").unwrap().api_resource());
        o.data = data;
        o
    }

    #[test]
    fn every_kind_resolves_to_an_api_path() {
        for spec in KINDS {
            let resource = spec.api_resource();
            assert_eq!(resource.plural, spec.id);
            assert_eq!(resource.kind, spec.kind);
        }
    }

    #[test]
    fn deployment_shows_ready_replicas() {
        let o = object(json!({
            "spec": { "replicas": 3 },
            "status": { "readyReplicas": 2, "updatedReplicas": 3, "availableReplicas": 2 }
        }));
        assert_eq!(
            deployment(&o),
            (vec!["2/3".into(), "3".into(), "2".into()], Some(PENDING))
        );
    }

    #[test]
    fn service_lists_node_ports() {
        let o = object(json!({
            "spec": {
                "type": "NodePort",
                "clusterIP": "10.0.0.1",
                "ports": [{ "port": 80, "nodePort": 30080, "protocol": "TCP" }]
            }
        }));
        let (cells, _) = service(&o);
        assert_eq!(cells, ["NodePort", "10.0.0.1", "—", "80:30080/TCP"]);
    }

    #[test]
    fn event_age_prefers_the_latest_occurrence() {
        let data =
            json!({ "eventTime": "2026-01-01T00:00:00Z", "lastTimestamp": "2026-01-02T00:00:00Z" });
        assert_eq!(last_seen(&data).as_deref(), Some("2026-01-02T00:00:00Z"));
    }
}
