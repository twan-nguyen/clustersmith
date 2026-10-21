import { useEffect } from "react";

import { CommandPalette } from "@/components/command-palette";
import { ConnectingOverlay } from "@/components/connecting-overlay";
import { DetailsPanel } from "@/components/details-panel";
import { Dock } from "@/components/dock";
import { PodsView } from "@/components/pods-view";
import { PortForwardsView } from "@/components/port-forwards-view";
import { ResourceView } from "@/components/resource-view";
import { SettingsView } from "@/components/settings-view";
import { Sidebar } from "@/components/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ResourceKind } from "@/lib/kube";
import { findKind, useStore } from "@/store";

/**
 * Stands in for a remembered custom kind until its cluster lists it, so its
 * rows show at once; the columns arrive with the real definition.
 */
function placeholderKind(id: string): ResourceKind {
  const name = id.replace(/^crd:/, "").split(".")[0];
  return {
    id,
    label: name,
    singular: name,
    section: "Custom Resources",
    namespaced: true,
    columns: [],
    ageLabel: "Age",
    restartable: false,
    scalable: false,
    group: "",
    version: "",
  };
}

function App() {
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);
  const transparency = useStore((s) => s.transparency);
  const kindId = useStore((s) => s.kind);
  const known = useStore((s) => findKind(s, s.kind));
  const kind = known ?? (kindId !== "pods" ? placeholderKind(kindId) : undefined);
  const selected = useStore((s) => s.selected);

  useEffect(() => {
    init();
  }, [init]);

  // The window is transparent; the canvas tint decides how much blur shows through.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("vibrancy", transparency > 0);
    root.style.setProperty("--canvas-opacity", `${100 - transparency}%`);
  }, [transparency]);

  // ⌘, opens Settings as in any macOS app; Esc leaves it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { view, setView, paletteOpen } = useStore.getState();
      if (event.key === "," && event.metaKey) {
        event.preventDefault();
        setView(view === "settings" ? "pods" : "settings");
      } else if (
        event.key === "Escape" &&
        view === "settings" &&
        !paletteOpen &&
        // Esc belongs to the dock's shells (vim) and editors (closing completions).
        !(event.target instanceof Element && event.target.closest(".xterm, .cm-editor"))
      ) {
        setView("pods");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <TooltipProvider>
      {/* The gutter around the panel doubles as a window drag handle. */}
      <div data-tauri-drag-region className="app-canvas flex h-screen py-2 pr-2">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {view === "settings" ? (
            <SettingsView />
          ) : view === "forwards" ? (
            <PortForwardsView />
          ) : (
            <div className="flex min-h-0 flex-1 gap-2">
              {kind && kind.id !== "pods" ? (
                // Keyed so sorting and scroll start fresh for each kind.
                <ResourceView key={kind.id} kind={kind} />
              ) : (
                <PodsView />
              )}
              {selected && <DetailsPanel selection={selected} />}
            </div>
          )}
          <Dock />
        </div>
      </div>
      <CommandPalette />
      <ConnectingOverlay />
    </TooltipProvider>
  );
}

export default App;
