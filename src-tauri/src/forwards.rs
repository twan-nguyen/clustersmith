use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use k8s_openapi::{
    api::core::v1::{Pod, Service},
    apimachinery::pkg::util::intstr::IntOrString,
};
use kube::{Api, ResourceExt, api::ListParams};
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, State,
    async_runtime::{self, JoinHandle},
};
use tokio::{
    io::copy_bidirectional,
    net::{TcpListener, TcpStream},
    task::JoinSet,
};

use crate::{clients::Clients, kubeconfig::KubeconfigSources};

/// Sent with the full list whenever a forward starts, stops or changes state.
const CHANGED: &str = "port-forwards-changed";

/// A port an object declares, offered when starting a forward.
#[derive(Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortChoice {
    port: u16,
    name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    id: u64,
    context: String,
    namespace: String,
    /// `pods` or `services`.
    resource: String,
    name: String,
    /// The pod's port, or for a service the service port.
    port: u16,
    local_port: u16,
    /// The pod connections currently go to.
    pod: Option<String>,
    /// Why the last connection failed; the next one that works clears it.
    error: Option<String>,
}

struct Forward {
    info: ForwardInfo,
    task: JoinHandle<()>,
}

/// Running port forwards. They live as long as the app, like Lens's.
#[derive(Default)]
pub struct Forwards {
    next_id: AtomicU64,
    running: Mutex<BTreeMap<u64, Forward>>,
}

impl Forwards {
    fn list(&self) -> Vec<ForwardInfo> {
        let running = self.running.lock().unwrap();
        running.values().map(|f| f.info.clone()).collect()
    }
}

/// Where connections go. A service is resolved to one of its ready pods, the
/// way `kubectl port-forward svc/...` does; when that pod goes away, the next
/// connection picks another.
enum Target {
    Pod {
        name: String,
        port: u16,
    },
    Service {
        selector: BTreeMap<String, String>,
        target_port: IntOrString,
    },
}

/// The pod and port the last connection used, reused until one fails.
type Picked = Mutex<Option<(String, u16)>>;

#[tauri::command]
pub async fn list_forward_ports(
    context: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
) -> Result<Vec<PortChoice>, String> {
    let client = clients.get(&sources, &context).await?;
    let namespace = namespace.ok_or("port forwarding needs a namespace")?;
    // Port forwarding carries TCP only.
    let tcp = |protocol: &Option<String>| protocol.as_deref().unwrap_or("TCP") == "TCP";
    let mut choices: Vec<PortChoice> = match kind.as_str() {
        "pods" => {
            let pod = Api::<Pod>::namespaced(client, &namespace)
                .get(&name)
                .await
                .map_err(|e| e.to_string())?;
            pod.spec
                .iter()
                .flat_map(|s| &s.containers)
                .flat_map(|c| c.ports.iter().flatten())
                .filter(|p| tcp(&p.protocol))
                .filter_map(|p| {
                    Some(PortChoice {
                        port: u16::try_from(p.container_port).ok()?,
                        name: p.name.clone(),
                    })
                })
                .collect()
        }
        "services" => {
            let service = Api::<Service>::namespaced(client, &namespace)
                .get(&name)
                .await
                .map_err(|e| e.to_string())?;
            service
                .spec
                .iter()
                .flat_map(|s| s.ports.iter().flatten())
                .filter(|p| tcp(&p.protocol))
                .filter_map(|p| {
                    Some(PortChoice {
                        port: u16::try_from(p.port).ok()?,
                        name: p.name.clone(),
                    })
                })
                .collect()
        }
        other => return Err(format!("{other} cannot be port-forwarded")),
    };
    choices.dedup();
    Ok(choices)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_port_forward(
    context: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    port: u16,
    local_port: Option<u16>,
    app: AppHandle,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
    forwards: State<'_, Forwards>,
) -> Result<ForwardInfo, String> {
    let client = clients.get(&sources, &context).await?;
    let namespace = namespace.ok_or("port forwarding needs a namespace")?;
    let target = match kind.as_str() {
        "pods" => Target::Pod {
            name: name.clone(),
            port,
        },
        "services" => {
            service_target(&Api::namespaced(client.clone(), &namespace), &name, port).await?
        }
        other => return Err(format!("{other} cannot be port-forwarded")),
    };
    let pods: Api<Pod> = Api::namespaced(client, &namespace);
    // Fail here, not on the first connection, when nothing can serve it.
    let first = pick(&pods, &target).await?;

    let listener = TcpListener::bind(("127.0.0.1", local_port.unwrap_or(0)))
        .await
        .map_err(|e| match local_port {
            Some(p) if e.kind() == std::io::ErrorKind::AddrInUse => {
                format!("port {p} is already in use on this Mac")
            }
            _ => e.to_string(),
        })?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let id = forwards.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let info = ForwardInfo {
        id,
        context,
        namespace,
        resource: kind,
        name,
        port,
        local_port,
        pod: Some(first.0.clone()),
        error: None,
    };
    let picked = Arc::new(Mutex::new(Some(first)));
    let task = async_runtime::spawn(accept(
        app.clone(),
        id,
        pods,
        Arc::new(target),
        picked,
        listener,
    ));
    forwards.running.lock().unwrap().insert(
        id,
        Forward {
            info: info.clone(),
            task,
        },
    );
    let _ = app.emit(CHANGED, forwards.list());
    Ok(info)
}

#[tauri::command]
pub fn stop_port_forward(id: u64, app: AppHandle, forwards: State<'_, Forwards>) {
    if let Some(forward) = forwards.running.lock().unwrap().remove(&id) {
        forward.task.abort();
    }
    let _ = app.emit(CHANGED, forwards.list());
}

#[tauri::command]
pub fn list_port_forwards(forwards: State<'_, Forwards>) -> Vec<ForwardInfo> {
    forwards.list()
}

async fn service_target(api: &Api<Service>, name: &str, port: u16) -> Result<Target, String> {
    let service = api.get(name).await.map_err(|e| e.to_string())?;
    let spec = service.spec.unwrap_or_default();
    let selector = spec
        .selector
        .filter(|s| !s.is_empty())
        .ok_or("this service has no selector, so it has no pods to forward to")?;
    let service_port = spec
        .ports
        .unwrap_or_default()
        .into_iter()
        .find(|p| p.port == i32::from(port))
        .ok_or_else(|| format!("the service has no port {port}"))?;
    Ok(Target::Service {
        selector,
        // An unset target port means the same number as the service port.
        target_port: service_port
            .target_port
            .unwrap_or(IntOrString::Int(i32::from(port))),
    })
}

/// The pod and pod port a new connection should go to.
async fn pick(pods: &Api<Pod>, target: &Target) -> Result<(String, u16), String> {
    match target {
        Target::Pod { name, port } => {
            let pod = pods.get(name).await.map_err(|e| e.to_string())?;
            if !is_running(&pod) {
                return Err(format!("pod {name} is not running"));
            }
            Ok((name.clone(), *port))
        }
        Target::Service {
            selector,
            target_port,
        } => {
            let labels = selector
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(",");
            let list = pods
                .list(&ListParams::default().labels(&labels))
                .await
                .map_err(|e| e.to_string())?;
            let pod = list
                .items
                .into_iter()
                .filter(is_ready)
                .min_by_key(|p| p.name_any())
                .ok_or("no ready pod backs this service")?;
            let port = pod_port(&pod, target_port)?;
            Ok((pod.name_any(), port))
        }
    }
}

fn is_running(pod: &Pod) -> bool {
    pod.metadata.deletion_timestamp.is_none()
        && pod.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running")
}

fn is_ready(pod: &Pod) -> bool {
    is_running(pod)
        && pod
            .status
            .as_ref()
            .and_then(|s| s.conditions.as_ref())
            .is_some_and(|c| c.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
}

/// Resolves a service's target port, which may name a container port.
fn pod_port(pod: &Pod, target: &IntOrString) -> Result<u16, String> {
    let number = match target {
        IntOrString::Int(n) => *n,
        IntOrString::String(name) => pod
            .spec
            .iter()
            .flat_map(|s| &s.containers)
            .flat_map(|c| c.ports.iter().flatten())
            .find(|p| p.name.as_deref() == Some(name))
            .map(|p| p.container_port)
            .ok_or_else(|| format!("pod {} has no port named {name}", pod.name_any()))?,
    };
    u16::try_from(number).map_err(|_| format!("port {number} is out of range"))
}

/// Serves connections until the forward is stopped. Aborting this task drops
/// the set, which closes every open connection with it.
async fn accept(
    app: AppHandle,
    id: u64,
    pods: Api<Pod>,
    target: Arc<Target>,
    picked: Arc<Picked>,
    listener: TcpListener,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                if let Ok((tcp, _)) = accepted {
                    let (app, pods, target, picked) = (app.clone(), pods.clone(), target.clone(), picked.clone());
                    connections.spawn(async move {
                        let result = serve(&pods, &target, &picked, tcp).await;
                        report(&app, id, result);
                    });
                }
            }
            Some(_) = connections.join_next() => {}
        }
    }
}

/// Carries one connection. Each gets its own stream to the pod, so when a
/// load balancer cuts an idle one, only that connection ends.
async fn serve(
    pods: &Api<Pod>,
    target: &Target,
    picked: &Picked,
    mut tcp: TcpStream,
) -> Result<String, String> {
    // A stale pick (the pod was replaced) gets one retry with a fresh one.
    let mut fresh = false;
    let (pod, port, mut forwarder) = loop {
        let cached = picked.lock().unwrap().clone();
        let (pod, port) = match cached {
            Some(choice) => choice,
            None => {
                fresh = true;
                pick(pods, target).await?
            }
        };
        match pods.portforward(&pod, &[port]).await {
            Ok(forwarder) => {
                *picked.lock().unwrap() = Some((pod.clone(), port));
                break (pod, port, forwarder);
            }
            Err(err) => {
                *picked.lock().unwrap() = None;
                if fresh {
                    return Err(err.to_string());
                }
            }
        }
    };

    let mut upstream = forwarder
        .take_stream(port)
        .ok_or("the port stream is missing")?;
    let error = forwarder
        .take_error(port)
        .ok_or("the port error channel is missing")?;
    let outcome = tokio::select! {
        _ = copy_bidirectional(&mut tcp, &mut upstream) => Ok(pod),
        Some(message) = error => Err(tidy_error(&message, port)),
    };
    drop(upstream);
    forwarder.abort();
    let _ = forwarder.join().await;
    outcome
}

/// The kubelet reports a closed port as a long socat log line.
fn tidy_error(message: &str, port: u16) -> String {
    if message.contains("Connection refused") {
        format!("nothing is listening on port {port} in the pod")
    } else {
        message.trim().to_owned()
    }
}

/// Records which pod served the last connection, or why it failed.
fn report(app: &AppHandle, id: u64, result: Result<String, String>) {
    let forwards = app.state::<Forwards>();
    let changed = {
        let mut running = forwards.running.lock().unwrap();
        let Some(info) = running.get_mut(&id).map(|f| &mut f.info) else {
            return;
        };
        let (pod, error) = match result {
            Ok(pod) => (Some(pod), None),
            Err(error) => (info.pod.clone(), Some(error)),
        };
        let changed = info.pod != pod || info.error != error;
        info.pod = pod;
        info.error = error;
        changed
    };
    if changed {
        let _ = app.emit(CHANGED, forwards.list());
    }
}

#[cfg(test)]
mod tests {
    use k8s_openapi::api::core::v1::{Container, ContainerPort, PodSpec};

    use super::*;

    fn pod_with_port(name: &str, port: i32) -> Pod {
        Pod {
            spec: Some(PodSpec {
                containers: vec![Container {
                    ports: Some(vec![ContainerPort {
                        name: Some(name.into()),
                        container_port: port,
                        ..Default::default()
                    }]),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn target_port_resolves_by_number_or_name() {
        let pod = pod_with_port("http", 8080);
        assert_eq!(pod_port(&pod, &IntOrString::Int(9000)), Ok(9000));
        assert_eq!(
            pod_port(&pod, &IntOrString::String("http".into())),
            Ok(8080)
        );
        assert!(pod_port(&pod, &IntOrString::String("grpc".into())).is_err());
    }

    #[test]
    fn closed_port_error_is_readable() {
        let raw = "error forwarding port 1 to pod abc, uid : exit status 1: socat[1] E \
                   connect(5, AF=2 127.0.0.1:1, 16): Connection refused\n";
        assert_eq!(
            tidy_error(raw, 1),
            "nothing is listening on port 1 in the pod"
        );
        assert_eq!(tidy_error(" timeout \n", 1), "timeout");
    }
}
