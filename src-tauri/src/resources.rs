use kube::{
    Api, Client, ResourceExt,
    api::{ApiResource, DynamicObject, GroupVersionKind},
};
use serde::Serialize;
use serde_json::Value;
use tauri::{State, ipc::Channel};

use crate::{
    clients::Clients,
    custom,
    kubeconfig::KubeconfigSources,
    watch::{ViewWatch, WatchEvent, run_watch},
};

/// A row color, matching the UI's status icons.
pub type Tone = &'static str;
pub const OK: Tone = "ok";
pub const DONE: Tone = "done";
pub const PENDING: Tone = "pending";
pub const FAILED: Tone = "failed";

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

type RowFn = fn(&DynamicObject) -> (Vec<String>, Option<Tone>);

/// One kind of object the sidebar lists, with the columns `kubectl get` shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindSpec {
    pub id: &'static str,
    label: &'static str,
    section: &'static str,
    /// Empty for the core API.
    group: &'static str,
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
    row: RowFn,
}

impl KindSpec {
    fn api_resource(&self) -> ApiResource {
        let gvk = GroupVersionKind::gvk(self.group, self.version, self.kind);
        ApiResource::from_gvk_with_plural(&gvk, self.id)
    }
}

/// How a row's cells are read: a built-in kind's own function, or the
/// printer columns a custom resource definition declares.
pub enum Cells {
    Builtin(RowFn),
    Printer(Vec<String>),
}

/// What watches and actions need to know about a kind, built in or custom.
pub struct Resolved {
    pub id: String,
    pub resource: ApiResource,
    pub namespaced: bool,
    pub restartable: bool,
    pub scalable: bool,
    pub cells: Cells,
}

impl From<&'static KindSpec> for Resolved {
    fn from(spec: &'static KindSpec) -> Self {
        Resolved {
            id: spec.id.to_owned(),
            resource: spec.api_resource(),
            namespaced: spec.namespaced,
            restartable: spec.restartable,
            scalable: spec.scalable,
            cells: Cells::Builtin(spec.row),
        }
    }
}

impl Resolved {
    /// Scoped to `namespace` when given and the kind lives in namespaces.
    pub fn api(&self, client: Client, namespace: Option<&str>) -> Api<DynamicObject> {
        match namespace.filter(|_| self.namespaced) {
            Some(ns) => Api::namespaced_with(client, ns, &self.resource),
            None => Api::all_with(client, &self.resource),
        }
    }

    fn row(&self, object: &DynamicObject) -> ResourceRow {
        let (cells, tone) = match &self.cells {
            Cells::Builtin(row) => row(object),
            Cells::Printer(paths) => custom::printer_row(paths, object),
        };
        let created = || {
            object
                .metadata
                .creation_timestamp
                .as_ref()
                .map(|t| t.0.to_string())
        };
        let age = if self.id == "events" {
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
}

/// Looks a kind up by the id the UI uses: a built-in plural name, or a
/// custom resource definition's name behind [`custom::PREFIX`].
pub async fn resolve(client: &Client, id: &str) -> Result<Resolved, String> {
    match id.strip_prefix(custom::PREFIX) {
        Some(name) => custom::resolve(client, name).await,
        None => find(id).map(Resolved::from),
    }
}

const fn kind(
    id: &'static str,
    label: &'static str,
    section: &'static str,
    (group, version, kind): (&'static str, &'static str, &'static str),
    namespaced: bool,
    columns: &'static [Column],
    row: RowFn,
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
    KindSpec {
        scalable: true,
        ..kind(
            "replicasets",
            "ReplicaSets",
            "Workloads",
            ("apps", "v1", "ReplicaSet"),
            true,
            &[col("Desired"), col("Current"), col("Ready")],
            replica_set,
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
        "networkpolicies",
        "Network Policies",
        "Network",
        ("networking.k8s.io", "v1", "NetworkPolicy"),
        true,
        &[col("Pod selector"), col("Policy types")],
        network_policy,
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
        "horizontalpodautoscalers",
        "Autoscalers",
        "Config",
        ("autoscaling", "v2", "HorizontalPodAutoscaler"),
        true,
        &[
            col("Reference"),
            col("Targets"),
            col("Min pods"),
            col("Max pods"),
            col("Replicas"),
        ],
        autoscaler,
    ),
    kind(
        "poddisruptionbudgets",
        "Disruption Budgets",
        "Config",
        ("policy", "v1", "PodDisruptionBudget"),
        true,
        &[
            col("Min available"),
            col("Max unavailable"),
            col("Allowed disruptions"),
        ],
        disruption_budget,
    ),
    kind(
        "persistentvolumeclaims",
        "Volume Claims",
        "Storage",
        ("", "v1", "PersistentVolumeClaim"),
        true,
        &[
            col("Status"),
            col("Volume"),
            col("Capacity"),
            col("Access modes"),
            col("Storage class"),
        ],
        volume_claim,
    ),
    kind(
        "persistentvolumes",
        "Volumes",
        "Storage",
        ("", "v1", "PersistentVolume"),
        false,
        &[
            col("Capacity"),
            col("Access modes"),
            col("Reclaim policy"),
            col("Status"),
            col("Claim"),
            col("Storage class"),
        ],
        volume,
    ),
    kind(
        "storageclasses",
        "Storage Classes",
        "Storage",
        ("storage.k8s.io", "v1", "StorageClass"),
        false,
        &[
            col("Provisioner"),
            col("Reclaim policy"),
            col("Binding mode"),
            col("Default"),
        ],
        storage_class,
    ),
    kind(
        "serviceaccounts",
        "Service Accounts",
        "Access Control",
        ("", "v1", "ServiceAccount"),
        true,
        &[col("Secrets")],
        service_account,
    ),
    kind(
        "roles",
        "Roles",
        "Access Control",
        ("rbac.authorization.k8s.io", "v1", "Role"),
        true,
        &[col("Rules")],
        role,
    ),
    kind(
        "rolebindings",
        "Role Bindings",
        "Access Control",
        ("rbac.authorization.k8s.io", "v1", "RoleBinding"),
        true,
        &[col("Role"), col("Subjects")],
        role_binding,
    ),
    kind(
        "clusterroles",
        "Cluster Roles",
        "Access Control",
        ("rbac.authorization.k8s.io", "v1", "ClusterRole"),
        false,
        &[col("Rules")],
        role,
    ),
    kind(
        "clusterrolebindings",
        "Cluster Role Bindings",
        "Access Control",
        ("rbac.authorization.k8s.io", "v1", "ClusterRoleBinding"),
        false,
        &[col("Role"), col("Subjects")],
        role_binding,
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
    let generation = watch.begin();
    let client = clients.get(&sources, &context).await?;
    let kind = resolve(&client, &kind).await?;
    let api = kind.api(client, namespace.as_deref());
    let resource = kind.resource.clone();
    let rows = move |object: &DynamicObject| kind.row(object);
    watch.start(generation, run_watch(api, resource, on_event, rows));
    Ok(())
}

// Field access over the untyped object. Missing fields read as empty or zero.

pub fn at<'a>(value: &'a Value, path: &[&str]) -> &'a Value {
    path.iter().fold(value, |v, key| &v[*key])
}

pub fn text(value: &Value, path: &[&str]) -> String {
    match at(value, path) {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

pub fn int(value: &Value, path: &[&str]) -> i64 {
    at(value, path).as_i64().unwrap_or(0)
}

pub fn list<'a>(value: &'a Value, path: &[&str]) -> &'a [Value] {
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

fn replica_set(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let desired = int(d, &["spec", "replicas"]);
    let ready = int(d, &["status", "readyReplicas"]);
    let cells = vec![
        desired.to_string(),
        int(d, &["status", "replicas"]).to_string(),
        ready.to_string(),
    ];
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

/// `app=web, tier=api`, as label selectors read on the command line.
fn labels_text(value: &Value) -> String {
    value
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn network_policy(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let selector = match labels_text(at(d, &["spec", "podSelector", "matchLabels"])) {
        s if s.is_empty() => "All pods".into(),
        s => s,
    };
    let types = list(d, &["spec", "policyTypes"])
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    (vec![selector, or_dash(types)], None)
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

/// `cpu 40%/80%` per metric, like the TARGETS column of `kubectl get hpa`.
fn autoscaler(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let current = list(d, &["status", "currentMetrics"]);
    let targets = list(d, &["spec", "metrics"])
        .iter()
        .map(|metric| {
            let kind = text(metric, &["type"]);
            if kind != "Resource" {
                return kind;
            }
            let name = text(metric, &["resource", "name"]);
            let now = current
                .iter()
                .find(|c| c["resource"]["name"] == name.as_str())
                .map(|c| &c["resource"]["current"]);
            let target = &metric["resource"]["target"];
            let (now, target) = match target["averageUtilization"].as_i64() {
                Some(goal) => (
                    now.and_then(|c| c["averageUtilization"].as_i64())
                        .map_or("?".into(), |n| format!("{n}%")),
                    format!("{goal}%"),
                ),
                None => (
                    now.map_or("?".into(), |c| text(c, &["averageValue"])),
                    text(target, &["averageValue"]),
                ),
            };
            format!("{name} {now}/{target}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let cells = vec![
        format!(
            "{}/{}",
            text(d, &["spec", "scaleTargetRef", "kind"]),
            text(d, &["spec", "scaleTargetRef", "name"])
        ),
        or_dash(targets),
        at(d, &["spec", "minReplicas"])
            .as_i64()
            .unwrap_or(1)
            .to_string(),
        int(d, &["spec", "maxReplicas"]).to_string(),
        int(d, &["status", "currentReplicas"]).to_string(),
    ];
    (cells, None)
}

fn disruption_budget(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let allowed = int(d, &["status", "disruptionsAllowed"]);
    let cells = vec![
        or_dash(text(d, &["spec", "minAvailable"])),
        or_dash(text(d, &["spec", "maxUnavailable"])),
        allowed.to_string(),
    ];
    // Nothing may be evicted now, so a node drain would wait on it.
    (cells, Some(if allowed > 0 { OK } else { PENDING }))
}

/// `RWO, RWX`, the short forms `kubectl` prints.
fn access_modes(value: &Value) -> String {
    let modes = value.as_array().map_or(&[][..], Vec::as_slice);
    let short = modes
        .iter()
        .filter_map(Value::as_str)
        .map(|m| match m {
            "ReadWriteOnce" => "RWO",
            "ReadOnlyMany" => "ROX",
            "ReadWriteMany" => "RWX",
            "ReadWriteOncePod" => "RWOP",
            other => other,
        })
        .collect::<Vec<_>>();
    or_dash(short.join(", "))
}

fn volume_claim(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let phase = text(d, &["status", "phase"]);
    let tone = match phase.as_str() {
        "Bound" => OK,
        "Lost" => FAILED,
        _ => PENDING,
    };
    let cells = vec![
        phase,
        or_dash(text(d, &["spec", "volumeName"])),
        or_dash(text(d, &["status", "capacity", "storage"])),
        access_modes(at(d, &["spec", "accessModes"])),
        or_dash(text(d, &["spec", "storageClassName"])),
    ];
    (cells, Some(tone))
}

fn volume(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let phase = text(d, &["status", "phase"]);
    let tone = match phase.as_str() {
        "Bound" | "Available" => OK,
        "Released" => DONE,
        "Failed" => FAILED,
        _ => PENDING,
    };
    let claim = match text(d, &["spec", "claimRef", "name"]) {
        name if name.is_empty() => String::new(),
        name => format!("{}/{name}", text(d, &["spec", "claimRef", "namespace"])),
    };
    let cells = vec![
        or_dash(text(d, &["spec", "capacity", "storage"])),
        access_modes(at(d, &["spec", "accessModes"])),
        or_dash(text(d, &["spec", "persistentVolumeReclaimPolicy"])),
        phase,
        or_dash(claim),
        or_dash(text(d, &["spec", "storageClassName"])),
    ];
    (cells, Some(tone))
}

fn storage_class(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let default = o
        .annotations()
        .get("storageclass.kubernetes.io/is-default-class")
        .is_some_and(|v| v == "true");
    let or = |path: &[&str], fallback: &str| match text(d, path) {
        s if s.is_empty() => fallback.to_owned(),
        s => s,
    };
    let cells = vec![
        text(d, &["provisioner"]),
        or(&["reclaimPolicy"], "Delete"),
        or(&["volumeBindingMode"], "Immediate"),
        if default { "Yes" } else { "No" }.into(),
    ];
    (cells, None)
}

fn service_account(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    (vec![list(&o.data, &["secrets"]).len().to_string()], None)
}

fn role(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    (vec![list(&o.data, &["rules"]).len().to_string()], None)
}

fn role_binding(o: &DynamicObject) -> (Vec<String>, Option<Tone>) {
    let d = &o.data;
    let subjects = list(d, &["subjects"])
        .iter()
        .map(|s| format!("{} {}", text(s, &["kind"]), text(s, &["name"])))
        .collect::<Vec<_>>()
        .join(", ");
    let cells = vec![
        format!(
            "{}/{}",
            text(d, &["roleRef", "kind"]),
            text(d, &["roleRef", "name"])
        ),
        or_dash(subjects),
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
pub fn last_seen(data: &Value) -> Option<String> {
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
    fn autoscaler_shows_utilization_against_target() {
        let o = object(json!({
            "spec": {
                "scaleTargetRef": { "kind": "Deployment", "name": "web" },
                "maxReplicas": 5,
                "metrics": [{ "type": "Resource", "resource": {
                    "name": "cpu", "target": { "type": "Utilization", "averageUtilization": 80 }
                } }]
            },
            "status": {
                "currentReplicas": 2,
                "currentMetrics": [{ "type": "Resource", "resource": {
                    "name": "cpu", "current": { "averageUtilization": 40 }
                } }]
            }
        }));
        let (cells, _) = autoscaler(&o);
        assert_eq!(cells, ["Deployment/web", "cpu 40%/80%", "1", "5", "2"]);
    }

    #[test]
    fn claim_shows_short_access_modes() {
        let o = object(json!({
            "spec": { "accessModes": ["ReadWriteOnce", "ReadOnlyMany"], "volumeName": "pv-1" },
            "status": { "phase": "Bound", "capacity": { "storage": "10Gi" } }
        }));
        let (cells, tone) = volume_claim(&o);
        assert_eq!(cells, ["Bound", "pv-1", "10Gi", "RWO, ROX", "—"]);
        assert_eq!(tone, Some(OK));
    }

    #[test]
    fn event_age_prefers_the_latest_occurrence() {
        let data =
            json!({ "eventTime": "2026-01-01T00:00:00Z", "lastTimestamp": "2026-01-02T00:00:00Z" });
        assert_eq!(last_seen(&data).as_deref(), Some("2026-01-02T00:00:00Z"));
    }
}
