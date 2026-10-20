import { useEffect } from "react";

import { CommandPalette } from "@/components/command-palette";
import { PodsView } from "@/components/pods-view";
import { Sidebar } from "@/components/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useStore } from "@/store";

function App() {
  const init = useStore((s) => s.init);

  useEffect(() => {
    init();
  }, [init]);

  return (
    <TooltipProvider>
      <div className="flex h-screen">
        <Sidebar />
        <PodsView />
      </div>
      <CommandPalette />
    </TooltipProvider>
  );
}

export default App;
