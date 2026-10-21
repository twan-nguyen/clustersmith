import { Channel, invoke } from "@tauri-apps/api/core";

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
};

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
  | { type: "lines"; lines: string[] }
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
};

export function openLogs(target: PodTarget, onEvent: (event: LogEvent) => void) {
  const channel = new Channel<LogEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("open_logs", { ...target, onEvent: channel });
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
