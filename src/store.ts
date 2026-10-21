import { create } from "zustand";

import {
  type ClusterPrefs,
  type ContextList,
  type KubeContext,
  type KubeconfigSource,
  type ObjectRef,
  type PodRow,
  type PodTarget,
  type ResourceKind,
  type ResourceRow,
  type WatchEvent,
  addKubeconfig,
  getTransparency,
  listContexts,
  listNamespaces,
  listResourceKinds,
  removeKubeconfig,
  setTransparency,
  stopWatch,
  updateCluster,
  watchPods,
  watchResources,
} from "@/lib/kube";
import { errorMessage } from "@/lib/utils";

export type View = "pods" | "settings";
export type SettingsPage = "clusters" | "kubeconfig" | "appearance";

export type DockTab =
  | ({ id: string; kind: "logs" | "shell" } & PodTarget)
  | ({ id: string; kind: "yaml" } & ObjectRef);
export type PodTab = Extract<DockTab, { kind: "logs" | "shell" }>;
export type YamlTab = Extract<DockTab, { kind: "yaml" }>;
export type NewDockTab = Omit<PodTab, "id"> | Omit<YamlTab, "id">;

type State = {
  contexts: KubeContext[];
  sources: KubeconfigSource[];
  context: string | null;
  namespaces: string[];
  /** `null` means every namespace. */
  namespace: string | null;
  /** Kinds the sidebar lists, in order. */
  kinds: ResourceKind[];
  /** The kind on screen, by id; Pods have their own view. */
  kind: string;
  pods: PodRow[];
  resources: ResourceRow[];
  /** The first snapshot of the current list arrived. */
  loaded: boolean;
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
  /** Reloads the namespace list of the current context. */
  refreshNamespaces: () => Promise<void>;
  selectNamespace: (namespace: string | null) => void;
  selectKind: (kind: string) => void;
  setQuery: (query: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setView: (view: View) => void;
  setSettingsPage: (page: SettingsPage) => void;
  openTab: (tab: NewDockTab) => void;
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
    const { context, namespace, kind } = get();
    if (!context) return;
    const id = ++watchId;
    set({ pods: [], resources: [], loaded: false, error: null });

    const handle =
      <T>(show: (items: T[]) => void) =>
      (event: WatchEvent<T>) => {
        if (id !== watchId) return;
        if (event.type === "snapshot") {
          show(event.items);
          set({ loaded: true, error: null });
          // The cluster answers now; fill the namespace list if loading it failed.
          if (get().namespaces.length === 0) get().refreshNamespaces().catch(() => {});
        } else if (event.type === "recovered") {
          set({ error: null });
        } else {
          set({ error: event.message });
        }
      };
    const request =
      kind === "pods"
        ? watchPods(context, namespace, handle((pods: PodRow[]) => set({ pods })))
        : watchResources(
            context,
            kind,
            namespace,
            handle((resources: ResourceRow[]) => set({ resources })),
          );
    request.catch((error) => {
      if (id === watchId) set({ error: errorMessage(error) });
    });
  }

  /**
   * Keeps the selected context if it still exists. Nothing connects on its
   * own: a cluster may sit behind a VPN that is off, so the user picks one.
   */
  async function applyContexts({ contexts, sources }: ContextList) {
    set({ contexts, sources });
    const selected = get().context;
    if (!selected || contexts.some((c) => c.name === selected)) return;

    watchId++;
    set({ context: null, namespace: null, namespaces: [], pods: [], resources: [], loaded: false });
    await stopWatch();
  }

  return {
    contexts: [],
    sources: [],
    context: null,
    namespaces: [],
    namespace: null,
    kinds: [],
    kind: "pods",
    pods: [],
    resources: [],
    loaded: false,
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
      listResourceKinds().then((kinds) => set({ kinds }));
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
      // A failure is not shown here: the list view reports an unreachable
      // cluster, and the list is loaded again once it answers.
      await get().refreshNamespaces().catch(() => {});
    },

    async refreshNamespaces() {
      const { context } = get();
      if (!context) return;
      const namespaces = await listNamespaces(context);
      if (get().context === context) set({ namespaces });
    },

    selectNamespace(namespace) {
      set({ namespace });
      startWatch();
    },

    selectKind(kind) {
      set({ kind, query: "", view: "pods" });
      startWatch();
    },

    setQuery: (query) => set({ query }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setView: (view) => set({ view }),
    setSettingsPage: (settingsPage) => set({ settingsPage }),

    // Like Lens, every open is a new tab: two shells into one pod are both useful.
    openTab(newTab) {
      const tab = { ...newTab, id: crypto.randomUUID() } as DockTab;
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
