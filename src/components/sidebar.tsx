import { ArrowLeft, Box, ChevronDown, FileText, Search, Settings } from "lucide-react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

export function Sidebar() {
  const view = useStore((s) => s.view);

  return (
    <aside className="flex w-60 shrink-0 flex-col text-sidebar-foreground">
      {/* Leaves room for the macOS traffic lights and lets the window be dragged. */}
      <div data-tauri-drag-region className="h-10 shrink-0" />
      {view === "settings" ? <SettingsNav /> : <AppNav />}
    </aside>
  );
}

function AppNav() {
  const { contexts, context, selectContext, setPaletteOpen, setView } = useStore();

  return (
    <>
      <div className="flex items-center gap-1 px-3 pb-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">
                C
              </span>
              <span className="truncate text-sm font-semibold text-sidebar-accent-foreground">
                ClusterSmith
              </span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem onSelect={() => setView("settings")}>
              <Settings />
              Settings
              <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton label="Search (⌘K)" onClick={() => setPaletteOpen(true)}>
          <Search />
        </IconButton>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
        <Section title="Workloads">
          <NavItem icon={<Box />} label="Pods" active />
        </Section>

        <Section title="Clusters">
          {contexts.map((c) => (
            <NavItem
              key={c.name}
              icon={<ContextAvatar name={c.name} />}
              label={c.name}
              title={`${c.name} · ${c.cluster}`}
              active={c.name === context}
              onClick={() => selectContext(c.name)}
            />
          ))}
        </Section>
      </nav>
    </>
  );
}

function SettingsNav() {
  const setView = useStore((s) => s.setView);

  return (
    <>
      <div className="px-3 pb-3">
        <button
          onClick={() => setView("pods")}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground [&_svg]:size-4"
        >
          <ArrowLeft />
          Back to app
        </button>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
        <Section title="Clusters">
          <NavItem icon={<FileText />} label="Kubeconfig files" active />
        </Section>
      </nav>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-px">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-6 w-fit items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-sidebar-foreground"
      >
        {title}
        <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && children}
    </div>
  );
}

function NavItem({
  icon,
  label,
  title,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-7 items-center gap-2.5 rounded-md px-2 text-left hover:bg-sidebar-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

/** Stable tint per context name, like Linear's team avatars. */
const AVATAR_HUES = [276, 155, 80, 25, 220, 330];

function ContextAvatar({ name }: { name: string }) {
  const hash = [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const hue = AVATAR_HUES[hash % AVATAR_HUES.length];
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white"
      style={{ background: `oklch(0.55 0.13 ${hue})` }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
