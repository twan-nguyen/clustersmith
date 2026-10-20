import { Channel, invoke } from "@tauri-apps/api/core";

export type KubeContext = {
  name: string;
  cluster: string;
  namespace: string | null;
};

export type ContextList = {
  current: string | null;
  contexts: KubeContext[];
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
  | { type: "error"; message: string };

export const listContexts = () => invoke<ContextList>("list_contexts");

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
