import { create } from "zustand";

import {
  type ContextList,
  type KubeContext,
  type KubeconfigSource,
  type PodRow,
  addKubeconfig,
  listContexts,
  listNamespaces,
  removeKubeconfig,
  stopPodWatch,
  watchPods,
} from "@/lib/kube";

export type View = "pods" | "settings";

type State = {
  contexts: KubeContext[];
  sources: KubeconfigSource[];
  context: string | null;
  namespaces: string[];
  /** `null` means every namespace. */
  namespace: string | null;
  pods: PodRow[];
  podsLoaded: boolean;
  query: string;
  error: string | null;
  paletteOpen: boolean;
  view: View;

  init: () => Promise<void>;
  addKubeconfig: (path: string) => Promise<void>;
  removeKubeconfig: (path: string) => Promise<void>;
  selectContext: (name: string) => Promise<void>;
  selectNamespace: (namespace: string | null) => void;
  setQuery: (query: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setView: (view: View) => void;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Each watch gets a number; events from a replaced watch are dropped.
let watchId = 0;

export const useStore = create<State>()((set, get) => {
  function startWatch() {
    const { context, namespace } = get();
    if (!context) return;
    const id = ++watchId;
    set({ pods: [], podsLoaded: false, error: null });
    watchPods(context, namespace, (event) => {
      if (id !== watchId) return;
      if (event.type === "snapshot") {
        set({ pods: event.pods, podsLoaded: true, error: null });
      } else if (event.type === "recovered") {
        set({ error: null });
      } else {
        set({ error: event.message });
      }
    }).catch((error) => {
      if (id === watchId) set({ error: message(error) });
    });
  }

  /** Keeps the selected context if it still exists, otherwise falls back. */
  async function applyContexts({ current, contexts, sources }: ContextList) {
    set({ contexts, sources });
    const selected = get().context;
    if (selected && contexts.some((c) => c.name === selected)) return;

    const next = (current && contexts.some((c) => c.name === current) ? current : null)
      ?? contexts[0]?.name;
    if (next) return get().selectContext(next);

    watchId++;
    set({ context: null, namespace: null, namespaces: [], pods: [], podsLoaded: false });
    await stopPodWatch();
  }

  return {
    contexts: [],
    sources: [],
    context: null,
    namespaces: [],
    namespace: null,
    pods: [],
    podsLoaded: false,
    query: "",
    error: null,
    paletteOpen: false,
    view: "pods",

    async init() {
      try {
        await applyContexts(await listContexts());
      } catch (error) {
        set({ error: message(error) });
      }
    },

    async addKubeconfig(path) {
      await applyContexts(await addKubeconfig(path));
    },

    async removeKubeconfig(path) {
      await applyContexts(await removeKubeconfig(path));
    },

    async selectContext(name) {
      set({ context: name, namespace: null, namespaces: [] });
      startWatch();
      try {
        const namespaces = await listNamespaces(name);
        if (get().context === name) set({ namespaces });
      } catch (error) {
        if (get().context === name) set({ error: message(error) });
      }
    },

    selectNamespace(namespace) {
      set({ namespace });
      startWatch();
    },

    setQuery: (query) => set({ query }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setView: (view) => set({ view }),
  };
});
