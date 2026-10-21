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

export type PodEvent =
  | { type: "snapshot"; pods: PodRow[] }
  | { type: "error"; message: string }
  | { type: "recovered" };

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
  onEvent: (event: PodEvent) => void,
) {
  const channel = new Channel<PodEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("watch_pods", { context, namespace, onEvent: channel });
}

export const stopPodWatch = () => invoke<void>("stop_pod_watch");

export type LogEvent =
  | { type: "lines"; lines: string[] }
  | { type: "ended" }
  | { type: "error"; message: string };

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
