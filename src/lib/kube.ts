import { Channel, invoke } from "@tauri-apps/api/core";

export type KubeContext = {
  name: string;
  cluster: string;
  namespace: string | null;
};

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
