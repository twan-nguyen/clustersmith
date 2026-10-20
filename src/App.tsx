import { useEffect } from "react";

import { CommandPalette } from "@/components/command-palette";
import { PodsView } from "@/components/pods-view";
import { SettingsView } from "@/components/settings-view";
import { Sidebar } from "@/components/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useStore } from "@/store";

function App() {
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);

  useEffect(() => {
    init();
  }, [init]);

  // ⌘, opens Settings as in any macOS app; Esc leaves it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { view, setView, paletteOpen } = useStore.getState();
      if (event.key === "," && event.metaKey) {
        event.preventDefault();
        setView(view === "settings" ? "pods" : "settings");
      } else if (event.key === "Escape" && view === "settings" && !paletteOpen) {
        setView("pods");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <TooltipProvider>
      {/* The gutter around the panel doubles as a window drag handle. */}
      <div data-tauri-drag-region className="flex h-screen bg-sidebar py-2 pr-2">
        <Sidebar />
        {view === "settings" ? <SettingsView /> : <PodsView />}
      </div>
      <CommandPalette />
    </TooltipProvider>
  );
}

export default App;
