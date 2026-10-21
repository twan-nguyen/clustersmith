import { useEffect } from "react";

import { CommandPalette } from "@/components/command-palette";
import { Dock } from "@/components/dock";
import { PodsView } from "@/components/pods-view";
import { ResourceView } from "@/components/resource-view";
import { SettingsView } from "@/components/settings-view";
import { Sidebar } from "@/components/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useStore } from "@/store";

function App() {
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);
  const transparency = useStore((s) => s.transparency);
  const kind = useStore((s) => s.kinds.find((k) => k.id === s.kind));

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
          ) : kind && kind.id !== "pods" ? (
            // Keyed so sorting and scroll start fresh for each kind.
            <ResourceView key={kind.id} kind={kind} />
          ) : (
            <PodsView />
          )}
          <Dock />
        </div>
      </div>
      <CommandPalette />
    </TooltipProvider>
  );
}

export default App;
