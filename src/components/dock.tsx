import {
  ChevronDown,
  ChevronUp,
  FileCode,
  FilePlus,
  History,
  ScrollText,
  SquareTerminal,
  X,
} from "lucide-react";
import { Suspense, lazy, useState } from "react";

import { LogsView } from "@/components/logs-view";
import { cn } from "@/lib/utils";
import { type DockTab, useStore } from "@/store";

// xterm.js and CodeMirror are most of the bundle; load each with its first tab.
const ShellView = lazy(() =>
  import("@/components/shell-view").then((m) => ({ default: m.ShellView })),
);
const YamlView = lazy(() =>
  import("@/components/yaml-view").then((m) => ({ default: m.YamlView })),
);
const CreateView = lazy(() =>
  import("@/components/yaml-view").then((m) => ({ default: m.CreateView })),
);

const TAB_BAR_HEIGHT = 36;
const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 320;

/**
 * Log streams, shells and YAML editors, docked under the main panel like Lens's dock.
 * It lives outside the views, so a shell survives a trip to Settings.
 */
export function Dock() {
  const { dockTabs, activeTab, dockCollapsed, setActiveTab, closeTab, setDockCollapsed } =
    useStore();
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [resizing, setResizing] = useState(false);

  if (dockTabs.length === 0) return null;

  function startResize(event: React.PointerEvent) {
    const startY = event.clientY;
    const startHeight = height;
    setResizing(true);
    const onMove = (e: PointerEvent) => {
      const max = window.innerHeight * 0.75;
      setHeight(Math.min(max, Math.max(MIN_HEIGHT, startHeight + startY - e.clientY)));
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <section
      aria-label="Dock"
      className={cn(
        "relative flex shrink-0 animate-view-in flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_3px_oklch(0_0_0/30%)]",
        // Animate collapsing, but follow the pointer exactly while dragging.
        !resizing && "transition-[height] duration-200 ease-out-quart",
        resizing && "select-none",
      )}
      style={{ height: dockCollapsed ? TAB_BAR_HEIGHT : height }}
    >
      {!dockCollapsed && (
        <div
          aria-hidden
          onPointerDown={startResize}
          className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize"
        />
      )}

      <div
        role="tablist"
        onDoubleClick={(e) => e.target === e.currentTarget && setDockCollapsed(!dockCollapsed)}
        className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2"
      >
        {dockTabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTab}
            onSelect={() => setActiveTab(tab.id)}
            onClose={() => closeTab(tab.id)}
          />
        ))}
        <button
          onClick={() => setDockCollapsed(!dockCollapsed)}
          aria-label={dockCollapsed ? "Expand dock" : "Collapse dock"}
          title={dockCollapsed ? "Expand" : "Collapse"}
          className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
        >
          {dockCollapsed ? <ChevronUp /> : <ChevronDown />}
        </button>
      </div>

      <div className="relative min-h-0 flex-1" hidden={dockCollapsed}>
        {dockTabs.map((tab) => {
          const active = tab.id === activeTab;
          return (
            // Inactive tabs stay mounted but invisible, so streams keep running
            // and terminals keep their size and scrollback.
            <div
              key={tab.id}
              role="tabpanel"
              className={cn("absolute inset-0", !active && "invisible")}
            >
              <Suspense>
                {tab.kind === "yaml" ? (
                  <YamlView tab={tab} active={active && !dockCollapsed} />
                ) : tab.kind === "create" ? (
                  <CreateView tab={tab} active={active && !dockCollapsed} />
                ) : tab.kind === "logs" || tab.kind === "workload-logs" ? (
                  <LogsView tab={tab} active={active && !dockCollapsed} />
                ) : (
                  <ShellView tab={tab} active={active && !dockCollapsed} />
                )}
              </Suspense>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: DockTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { Icon, kindLabel, name, detail, where } = describe(tab);
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={`${kindLabel} · ${where}`}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      // Middle click closes, as in browsers and Lens.
      onAuxClick={(e) => e.button === 1 && onClose()}
      className={cn(
        "group flex h-7 max-w-64 shrink-0 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2 text-xs text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
      {detail && <span className="shrink-0 text-muted-foreground">· {detail}</span>}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={`Close ${name}`}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:bg-foreground/10 focus-visible:opacity-100",
          active && "opacity-100",
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/** How a tab names itself in the tab bar and its tooltip. */
function describe(tab: DockTab) {
  if (tab.kind === "create") {
    return {
      Icon: FilePlus,
      kindLabel: "New resource",
      name: "New resource",
      detail: null,
      where: [tab.context, tab.namespace].filter(Boolean).join(" / "),
    };
  }
  if (tab.kind === "workload-logs") {
    return {
      Icon: ScrollText,
      kindLabel: "Logs",
      name: tab.name,
      detail: "all pods",
      where: [tab.context, tab.resource, tab.namespace, tab.name].filter(Boolean).join(" / "),
    };
  }
  if (tab.kind === "yaml") {
    return {
      Icon: FileCode,
      kindLabel: "YAML",
      name: tab.name,
      detail: tab.resource,
      where: [tab.context, tab.resource, tab.namespace, tab.name].filter(Boolean).join(" / "),
    };
  }
  const previous = tab.kind === "logs" && tab.previous;
  return {
    Icon: previous ? History : tab.kind === "logs" ? ScrollText : SquareTerminal,
    kindLabel: previous ? "Previous logs" : tab.kind === "logs" ? "Logs" : "Shell",
    name: tab.pod,
    detail: [tab.container, previous && "previous"].filter(Boolean).join(" · ") || null,
    where: [tab.context, tab.namespace, tab.pod, tab.container].filter(Boolean).join(" / "),
  };
}
