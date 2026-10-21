import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type KubeContext = {
  name: string;
  cluster: string;
  namespace: string | null;
  /** Set in Settings; the kubeconfig keeps its own name. */
  displayName: string | null;
  /** Avatar hue in OKLCH degrees; `null` derives one from the name. */
  hue: number | null;
};

export type ClusterPrefs = {
  displayName: string | null;
  hue: number | null;
};

export const contextLabel = (context: KubeContext) => context.displayName ?? context.name;

export type KubeconfigSource = {
  path: string;
  /** `false` for files kubectl reads on its own (~/.kube/config, $KUBECONFIG). */
  imported: boolean;
  contexts: number;
  error: string | null;
};

export type ContextList = {
  current: string | null;
  contexts: KubeContext[];
  sources: KubeconfigSource[];
};

export type PodRow = {
  uid: string;
  name: string;
  namespace: string;
  status: string;
  ready: number;
  containers: number;
  containerNames: string[];
  restarts: number;
  createdAt: string | null;
  node: string | null;
};

/** What a list watch sends: the whole sorted list, or a connection change. */
export type WatchEvent<T> =
  | { type: "snapshot"; items: T[] }
  | { type: "error"; message: string }
  | { type: "recovered" };

export type ResourceColumn = {
  label: string;
  /** The cell is an RFC 3339 time, shown as an age. */
  time: boolean;
};

/** A kind the sidebar lists, as described by the Rust side. */
export type ResourceKind = {
  id: string;
  label: string;
  /** The API kind, such as "Deployment". */
  singular: string;
  section: string;
  namespaced: boolean;
  columns: ResourceColumn[];
  ageLabel: string;
  restartable: boolean;
  scalable: boolean;
  /** Empty for the core API; custom kinds are grouped by it in the sidebar. */
  group: string;
  version: string;
};

export const apiVersion = (kind: ResourceKind) =>
  kind.group ? `${kind.group}/${kind.version}` : kind.version;

/** Custom resource kinds are addressed as `crd:<definition name>`. */
export const isCustomKind = (id: string) => id.startsWith("crd:");

export const listCustomKinds = (context: string) =>
  invoke<ResourceKind[]>("list_custom_kinds", { context });

export type ResourceRow = {
  uid: string;
  name: string;
  namespace: string | null;
  /** One per `ResourceKind.columns` entry. */
  cells: string[];
  tone: "ok" | "done" | "pending" | "failed" | null;
  age: string | null;
};

/** One object, addressed by its kind's id (the API plural, e.g. "deployments"). */
export type ObjectRef = {
  context: string;
  resource: string;
  namespace: string | null;
  name: string;
};

const objectArgs = ({ context, resource, namespace, name }: ObjectRef) => ({
  context,
  kind: resource,
  namespace,
  name,
});

export const listContexts = () => invoke<ContextList>("list_contexts");

export const addKubeconfig = (path: string) =>
  invoke<ContextList>("add_kubeconfig", { path });

export const removeKubeconfig = (path: string) =>
  invoke<ContextList>("remove_kubeconfig", { path });

export const updateCluster = (name: string, prefs: ClusterPrefs) =>
  invoke<ContextList>("update_cluster", { name, prefs });

export const listNamespaces = (context: string) =>
  invoke<string[]>("list_namespaces", { context });

export function watchPods(
  context: string,
  namespace: string | null,
  onEvent: (event: WatchEvent<PodRow>) => void,
) {
  const channel = new Channel<WatchEvent<PodRow>>();
  channel.onmessage = onEvent;
  return invoke<void>("watch_pods", { context, namespace, onEvent: channel });
}

export const listResourceKinds = () => invoke<ResourceKind[]>("list_resource_kinds");

export function watchResources(
  context: string,
  kind: string,
  namespace: string | null,
  onEvent: (event: WatchEvent<ResourceRow>) => void,
) {
  const channel = new Channel<WatchEvent<ResourceRow>>();
  channel.onmessage = onEvent;
  return invoke<void>("watch_resources", { context, kind, namespace, onEvent: channel });
}

export const stopWatch = () => invoke<void>("stop_watch");

export const deleteResource = (ref: ObjectRef) => invoke<void>("delete_resource", objectArgs(ref));

export const restartWorkload = (ref: ObjectRef) =>
  invoke<void>("restart_workload", objectArgs(ref));

export const scaleWorkload = (ref: ObjectRef, replicas: number) =>
  invoke<void>("scale_workload", { ...objectArgs(ref), replicas });

export const getResourceYaml = (ref: ObjectRef) =>
  invoke<string>("get_resource_yaml", objectArgs(ref));

/** Saves edited YAML; resolves to what the server stored. */
export const applyResourceYaml = (ref: ObjectRef, yaml: string) =>
  invoke<string>("apply_resource_yaml", { ...objectArgs(ref), yaml });

export type LogEvent =
  /** `source` names the pod when a tab follows several. */
  | { type: "lines"; lines: string[]; source?: string }
  | { type: "reconnecting" }
  | { type: "live" }
  | { type: "ended" };

export type ShellEvent =
  | { type: "output"; data: string }
  | { type: "exited" }
  | { type: "error"; message: string };

/** Where a log stream or shell points. `container: null` picks the pod's default. */
export type PodTarget = {
  context: string;
  namespace: string;
  pod: string;
  container: string | null;
  /** The last terminated run of the container, as `kubectl logs --previous`. */
  previous?: boolean;
};

export function openLogs(target: PodTarget, onEvent: (event: LogEvent) => void) {
  const channel = new Channel<LogEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("open_logs", { previous: false, ...target, onEvent: channel });
}

export function openShell(
  target: PodTarget,
  size: { cols: number; rows: number },
  onEvent: (event: ShellEvent) => void,
) {
  const channel = new Channel<ShellEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("open_shell", { ...target, ...size, onEvent: channel });
}

export const shellInput = (id: number, data: string) => invoke<void>("shell_input", { id, data });

export const shellResize = (id: number, cols: number, rows: number) =>
  invoke<void>("shell_resize", { id, cols, rows });

export const closeSession = (id: number) => invoke<void>("close_session", { id });

export const getTransparency = () => invoke<number>("get_transparency");

export const setTransparency = (percent: number) =>
  invoke<void>("set_transparency", { percent });

/** A port an object declares, offered when starting a forward. */
export type PortChoice = { port: number; name: string | null };

export type PortForward = {
  id: number;
  context: string;
  namespace: string;
  resource: "pods" | "services";
  name: string;
  /** The pod's port, or for a service the service port. */
  port: number;
  localPort: number;
  /** The pod connections currently go to. */
  pod: string | null;
  /** Why the last connection failed; cleared once one works again. */
  error: string | null;
};

/** Objects whose ⋯ menu offers port forwarding. */
export const forwardable = (resource: string) => resource === "pods" || resource === "services";

export const listForwardPorts = (ref: ObjectRef) =>
  invoke<PortChoice[]>("list_forward_ports", objectArgs(ref));

export const startPortForward = (ref: ObjectRef, port: number, localPort: number | null) =>
  invoke<PortForward>("start_port_forward", { ...objectArgs(ref), port, localPort });

export const stopPortForward = (id: number) => invoke<void>("stop_port_forward", { id });

export const listPortForwards = () => invoke<PortForward[]>("list_port_forwards");

export const onPortForwardsChanged = (handler: (forwards: PortForward[]) => void) =>
  listen<PortForward[]>("port-forwards-changed", (event) => handler(event.payload));

export const forwardUrl = (forward: PortForward) => `http://localhost:${forward.localPort}`;

/** The same number as `port` when it is free locally, otherwise any free port. */
export const suggestLocalPort = (port: number) =>
  invoke<number | null>("suggest_local_port", { port });

/** Kinds whose pods a tab can follow together, and the details panel lists. */
export const hasPods = (resource: string) =>
  ["deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "services"].includes(
    resource,
  );

export function openWorkloadLogs(ref: ObjectRef, onEvent: (event: LogEvent) => void) {
  const channel = new Channel<LogEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("open_workload_logs", { ...objectArgs(ref), onEvent: channel });
}

export const saveLog = (path: string, text: string) => invoke<void>("save_log", { path, text });

// The API object as JSON; the details panel reads what each kind has.
export type KubeObject = Record<string, any>;

export type EventRow = {
  /** `Normal` or `Warning`. */
  kind: string;
  reason: string;
  message: string;
  count: number;
  lastSeen: string | null;
};

export type Details = {
  object: KubeObject;
  /** Newest first. */
  events: EventRow[];
  /** Pods the object selects or runs; `null` for kinds without pods. */
  pods: PodRow[] | null;
};

export const describeResource = (ref: ObjectRef) =>
  invoke<Details>("describe_resource", objectArgs(ref));

/** Cores and bytes; nodes also say what they can give. */
export type Usage = {
  cpu: number;
  memory: number;
  cpuAllocatable?: number;
  memoryAllocatable?: number;
};

/** Keyed `namespace/name` for pods, `name` for nodes; `null` without metrics-server. */
export const getMetrics = (context: string, kind: "pods" | "nodes", namespace: string | null) =>
  invoke<Record<string, Usage> | null>("get_metrics", { context, kind, namespace });

export const cordonNode = (context: string, name: string, cordon: boolean) =>
  invoke<void>("cordon_node", { context, name, cordon });

export type DrainReport = {
  evicted: string[];
  /** DaemonSet and static pods, left in place. */
  skipped: string[];
  /** Pods no controller recreates; listed without evicting unless forced. */
  unmanaged: string[];
  failed: { pod: string; error: string }[];
};

export const drainNode = (context: string, name: string, force: boolean) =>
  invoke<DrainReport>("drain_node", { context, name, force });

/** Creates every object in the YAML; resolves to `kind/name` of each. */
export const createResources = (context: string, namespace: string | null, yaml: string) =>
  invoke<string[]>("create_resources", { context, namespace, yaml });
