import { create } from "zustand";

import {
  type ClusterPrefs,
  type ContextList,
  type KubeContext,
  type KubeconfigSource,
  type PodRow,
  type PodTarget,
  addKubeconfig,
  getTransparency,
  listContexts,
  listNamespaces,
  removeKubeconfig,
  setTransparency,
  stopPodWatch,
  updateCluster,
  watchPods,
} from "@/lib/kube";
import { errorMessage } from "@/lib/utils";

export type View = "pods" | "settings";
export type SettingsPage = "clusters" | "kubeconfig" | "appearance";

export type DockTab = PodTarget & { id: string; kind: "logs" | "shell" };

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
  settingsPage: SettingsPage;
  dockTabs: DockTab[];
  activeTab: string | null;
  dockCollapsed: boolean;
  /** How much of the macOS blur shows through the background, 0–100. */
  transparency: number;

  init: () => Promise<void>;
  addKubeconfig: (path: string) => Promise<void>;
  removeKubeconfig: (path: string) => Promise<void>;
  updateCluster: (name: string, prefs: ClusterPrefs) => Promise<void>;
  selectContext: (name: string) => Promise<void>;
  selectNamespace: (namespace: string | null) => void;
  setQuery: (query: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setView: (view: View) => void;
  setSettingsPage: (page: SettingsPage) => void;
  openTab: (kind: DockTab["kind"], target: PodTarget) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setDockCollapsed: (collapsed: boolean) => void;
  /** Updates the look while dragging; saves only when the blur turns on or off. */
  previewTransparency: (percent: number) => Promise<void>;
  setTransparency: (percent: number) => Promise<void>;
};

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
      if (id === watchId) set({ error: errorMessage(error) });
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
    settingsPage: "clusters",
    dockTabs: [],
    activeTab: null,
    dockCollapsed: false,
    transparency: 0,

    async init() {
      getTransparency().then((transparency) => set({ transparency }));
      try {
        await applyContexts(await listContexts());
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },

    async addKubeconfig(path) {
      await applyContexts(await addKubeconfig(path));
    },

    async removeKubeconfig(path) {
      await applyContexts(await removeKubeconfig(path));
    },

    async updateCluster(name, prefs) {
      await applyContexts(await updateCluster(name, prefs));
    },

    async selectContext(name) {
      set({ context: name, namespace: null, namespaces: [] });
      startWatch();
      try {
        const namespaces = await listNamespaces(name);
        if (get().context === name) set({ namespaces });
      } catch (error) {
        if (get().context === name) set({ error: errorMessage(error) });
      }
    },

    selectNamespace(namespace) {
      set({ namespace });
      startWatch();
    },

    setQuery: (query) => set({ query }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setView: (view) => set({ view }),
    setSettingsPage: (settingsPage) => set({ settingsPage }),

    // Like Lens, every open is a new tab: two shells into one pod are both useful.
    openTab(kind, target) {
      const tab = { ...target, kind, id: crypto.randomUUID() };
      set((s) => ({ dockTabs: [...s.dockTabs, tab], activeTab: tab.id, dockCollapsed: false }));
    },

    closeTab(id) {
      set((s) => {
        const index = s.dockTabs.findIndex((t) => t.id === id);
        const dockTabs = s.dockTabs.filter((t) => t.id !== id);
        const neighbor = dockTabs[Math.min(index, dockTabs.length - 1)];
        const activeTab = s.activeTab === id ? (neighbor?.id ?? null) : s.activeTab;
        return { dockTabs, activeTab };
      });
    },

    setActiveTab: (activeTab) => set({ activeTab, dockCollapsed: false }),
    setDockCollapsed: (dockCollapsed) => set({ dockCollapsed }),

    async previewTransparency(percent) {
      const blurChanged = percent > 0 !== get().transparency > 0;
      set({ transparency: percent });
      // The blur itself lives in the native window, so crossing 0 needs Rust.
      if (blurChanged) await setTransparency(percent);
    },

    async setTransparency(percent) {
      set({ transparency: percent });
      await setTransparency(percent);
    },
  };
});
