import { create } from "zustand";

import {
  type KubeContext,
  type PodRow,
  listContexts,
  listNamespaces,
  watchPods,
} from "@/lib/kube";

type State = {
  contexts: KubeContext[];
  context: string | null;
  namespaces: string[];
  /** `null` means every namespace. */
  namespace: string | null;
  pods: PodRow[];
  podsLoaded: boolean;
  query: string;
  error: string | null;
  paletteOpen: boolean;

  init: () => Promise<void>;
  selectContext: (name: string) => Promise<void>;
  selectNamespace: (namespace: string | null) => void;
  setQuery: (query: string) => void;
  setPaletteOpen: (open: boolean) => void;
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
      } else {
        set({ error: event.message });
      }
    }).catch((error) => {
      if (id === watchId) set({ error: message(error) });
    });
  }

  return {
    contexts: [],
    context: null,
    namespaces: [],
    namespace: null,
    pods: [],
    podsLoaded: false,
    query: "",
    error: null,
    paletteOpen: false,

    async init() {
      try {
        const { current, contexts } = await listContexts();
        set({ contexts });
        const initial = current ?? contexts[0]?.name;
        if (initial) await get().selectContext(initial);
      } catch (error) {
        set({ error: message(error) });
      }
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
  };
});
