import { create } from "zustand";

import {
  type ClusterPrefs,
  type ContextList,
  type KubeContext,
  type KubeconfigSource,
  type ObjectRef,
  type PodRow,
  type PortForward,
  type PodTarget,
  type ResourceKind,
  type ResourceRow,
  type WatchEvent,
  addKubeconfig,
  getTransparency,
  isCustomKind,
  listContexts,
  listCustomKinds,
  listNamespaces,
  listPortForwards,
  onPortForwardsChanged,
  listResourceKinds,
  removeKubeconfig,
  setTransparency,
  stopWatch,
  updateCluster,
  watchPods,
  watchResources,
} from "@/lib/kube";
import { errorMessage } from "@/lib/utils";

export type View = "pods" | "forwards" | "settings";
export type SettingsPage = "clusters" | "kubeconfig" | "appearance";

export type DockTab =
  | ({ id: string; kind: "logs" | "shell" } & PodTarget)
  /** Every pod of a workload or service, in one tab. */
  | ({ id: string; kind: "workload-logs" } & ObjectRef)
  | ({ id: string; kind: "yaml" } & ObjectRef)
  /** A new object written from scratch; `namespace` is where unspecified ones go. */
  | { id: string; kind: "create"; context: string; namespace: string | null; template: string };
export type PodTab = Extract<DockTab, { kind: "logs" | "shell" }>;
export type WorkloadLogsTab = Extract<DockTab, { kind: "workload-logs" }>;
export type YamlTab = Extract<DockTab, { kind: "yaml" }>;
export type CreateTab = Extract<DockTab, { kind: "create" }>;
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
export type NewDockTab = WithoutId<DockTab>;

/** The object the details panel shows. */
export type Selection = ObjectRef & { uid: string };

type State = {
  contexts: KubeContext[];
  sources: KubeconfigSource[];
  context: string | null;
  namespaces: string[];
  /** `null` means every namespace. */
  namespace: string | null;
  /** Kinds the sidebar lists, in order. */
  kinds: ResourceKind[];
  /** The selected cluster's custom resource kinds, by API group. */
  customKinds: ResourceKind[];
  /** The kind on screen, by id; Pods have their own view. */
  kind: string;
  pods: PodRow[];
  resources: ResourceRow[];
  /** The first snapshot of the current list arrived. */
  loaded: boolean;
  /** A cluster was just picked and has not answered yet. */
  connecting: boolean;
  /** Why the cluster could not be reached, while nothing of it is loaded. */
  connectError: string | null;
  query: string;
  error: string | null;
  paletteOpen: boolean;
  view: View;
  settingsPage: SettingsPage;
  dockTabs: DockTab[];
  activeTab: string | null;
  dockCollapsed: boolean;
  /** Running port forwards, across every cluster. */
  forwards: PortForward[];
  /** Shown in the details panel beside the list. */
  selected: Selection | null;
  /** How much of the macOS blur shows through the background, 0–100. */
  transparency: number;

  init: () => Promise<void>;
  addKubeconfig: (path: string) => Promise<void>;
  removeKubeconfig: (path: string) => Promise<void>;
  updateCluster: (name: string, prefs: ClusterPrefs) => Promise<void>;
  selectContext: (name: string) => Promise<void>;
  /** Stops talking to the current cluster, back to the cluster picker. */
  disconnect: () => Promise<void>;
  /** Tries the current cluster again after it could not be reached. */
  reconnect: () => Promise<void>;
  /** Reloads the namespace list of the current context. */
  refreshNamespaces: () => Promise<void>;
  selectNamespace: (namespace: string | null) => void;
  selectKind: (kind: string) => void;
  select: (selection: Selection | null) => void;
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

/**
 * Errors that mean the API server was not reached at all (VPN off, DNS,
 * timeouts), as opposed to the server answering no, like a missing permission.
 */
const CONNECTION_ERROR =
  /\b(connect|connection|timed out|timeout|dns|resolve|unreachable|no route|refused|reset)\b/i;

/** Built-in and custom kinds together, to look one up by id. */
export const findKind = (s: Pick<State, "kinds" | "customKinds">, id: string) =>
  s.kinds.find((k) => k.id === id) ?? s.customKinds.find((k) => k.id === id);

/**
 * Where the user was in each cluster, so switching back lands there again.
 * Browser storage is enough: losing it only means starting at Pods.
 */
type Place = { kind: string; namespace: string | null };
const placeKey = (context: string) => `clustersmith.place.${context}`;

function loadPlace(context: string): Place | null {
  try {
    const place = JSON.parse(localStorage.getItem(placeKey(context)) ?? "null");
    return typeof place?.kind === "string" ? place : null;
  } catch {
    return null;
  }
}

function savePlace(context: string | null, place: Place) {
  if (!context) return;
  try {
    localStorage.setItem(placeKey(context), JSON.stringify(place));
  } catch {
    // Private mode or full storage: the place is simply not remembered.
  }
}

export const useStore = create<State>()((set, get) => {
  function startWatch() {
    const { context, namespace, kind } = get();
    if (!context) return;
    const id = ++watchId;
    set({ pods: [], resources: [], loaded: false, error: null, selected: null });
    savePlace(context, { kind, namespace });

    const handle =
      <T>(show: (items: T[]) => void) =>
      (event: WatchEvent<T>) => {
        if (id !== watchId) return;
        if (event.type === "snapshot") {
          show(event.items);
          set({ loaded: true, error: null, connecting: false, connectError: null });
          // The cluster answers now; fill the namespace list if loading it failed.
          if (get().namespaces.length === 0) get().refreshNamespaces().catch(() => {});
        } else if (event.type === "recovered") {
          set({ error: null });
        } else {
          fail(event.message);
        }
      };
    // Before anything loads, an unreachable server is a connection problem
    // for the whole cluster, not this list; the overlay offers a retry.
    const fail = (message: string) => {
      const unreachable = !get().loaded && CONNECTION_ERROR.test(message);
      set({ error: message, connecting: false, connectError: unreachable ? message : null });
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
      if (id === watchId) fail(errorMessage(error));
    });
  }

  /**
   * Keeps the selected context if it still exists. Nothing connects on its
   * own: a cluster may sit behind a VPN that is off, so the user picks one.
   */
  async function applyContexts({ contexts, sources }: ContextList) {
    set({ contexts, sources });
    const selected = get().context;
    if (selected && !contexts.some((c) => c.name === selected)) await get().disconnect();
  }

  return {
    contexts: [],
    sources: [],
    context: null,
    namespaces: [],
    namespace: null,
    kinds: [],
    customKinds: [],
    kind: "pods",
    pods: [],
    resources: [],
    loaded: false,
    connecting: false,
    connectError: null,
    query: "",
    error: null,
    paletteOpen: false,
    view: "pods",
    settingsPage: "clusters",
    dockTabs: [],
    activeTab: null,
    dockCollapsed: false,
    forwards: [],
    selected: null,
    transparency: 0,

    async init() {
      getTransparency().then((transparency) => set({ transparency }));
      listResourceKinds().then((kinds) => set({ kinds }));
      // Forwards outlive a webview reload, so the list is read back as well as followed.
      onPortForwardsChanged((forwards) => set({ forwards }));
      listPortForwards().then((forwards) => set({ forwards }));
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
      const place = loadPlace(name);
      // A custom kind is only known once its cluster lists it; start at it anyway.
      const known = place && (isCustomKind(place.kind) || get().kinds.some((k) => k.id === place.kind));
      set({
        context: name,
        namespace: place?.namespace ?? null,
        namespaces: [],
        customKinds: [],
        kind: known ? place.kind : "pods",
        query: "",
        connecting: true,
        connectError: null,
      });
      startWatch();
      listCustomKinds(name)
        .then((customKinds) => get().context === name && set({ customKinds }))
        // Without permission to list definitions, the section stays empty.
        .catch(() => {});
      // A failure is not shown here: the list view reports an unreachable
      // cluster, and the list is loaded again once it answers.
      await get().refreshNamespaces().catch(() => {});
    },

    async disconnect() {
      watchId++;
      set({
        context: null,
        namespace: null,
        namespaces: [],
        customKinds: [],
        pods: [],
        resources: [],
        loaded: false,
        connecting: false,
        connectError: null,
        error: null,
        selected: null,
      });
      await stopWatch();
    },

    async reconnect() {
      const { context } = get();
      // Picking it again also reloads its namespaces and custom kinds.
      if (context) await get().selectContext(context);
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

    select: (selected) => set({ selected }),

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
