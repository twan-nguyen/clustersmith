import {
  ArrowLeft,
  Box,
  Check,
  ChevronDown,
  ChevronsUpDown,
  FileText,
  Search,
  Server,
  Settings,
} from "lucide-react";
import { useState } from "react";

import appIcon from "../../app-icon.svg";
import { ContextAvatar } from "@/components/context-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { contextLabel } from "@/lib/kube";
import { type SettingsPage, useStore } from "@/store";

export function Sidebar() {
  const view = useStore((s) => s.view);

  return (
    <aside className="flex w-60 shrink-0 flex-col text-sidebar-foreground">
      {/* Leaves room for the macOS traffic lights and lets the window be dragged. */}
      <div data-tauri-drag-region className="h-10 shrink-0" />
      <div key={view} className="flex min-h-0 flex-1 animate-view-in flex-col">
        {view === "settings" ? <SettingsNav /> : <AppNav />}
      </div>
    </aside>
  );
}

function AppNav() {
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);

  return (
    <>
      <div className="flex items-center gap-1 px-3 pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
          {/* The icon art leaves macOS grid padding, so it renders a bit larger. */}
          <img src={appIcon} alt="" className="-m-0.5 size-6 shrink-0" />
          <span className="truncate text-sm font-semibold text-sidebar-accent-foreground">
            ClusterSmith
          </span>
        </div>
        <IconButton label="Search (⌘K)" onClick={() => setPaletteOpen(true)}>
          <Search />
        </IconButton>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
        <Section title="Workloads">
          <NavItem icon={<Box />} label="Pods" active />
        </Section>
      </nav>

      <div className="border-t border-sidebar-border px-3 py-2">
        <ClusterSwitcher />
      </div>
    </>
  );
}

/** Sits at the foot of the sidebar, like the workspace switcher in Slack. */
function ClusterSwitcher() {
  const { contexts, context, selectContext, setView } = useStore();
  const active = contexts.find((c) => c.name === context);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          title={active ? `${contextLabel(active)} · ${active.name}` : undefined}
          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors duration-100 hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent"
        >
          {active ? (
            <ContextAvatar context={active} />
          ) : (
            <span className="size-4 shrink-0 rounded border border-dashed border-muted-foreground/50" />
          )}
          <span className={cn("flex-1 truncate", !active && "text-muted-foreground")}>
            {active ? contextLabel(active) : "No cluster"}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        {contexts.length > 0 && (
          <>
            <DropdownMenuLabel>Clusters</DropdownMenuLabel>
            {contexts.map((c) => (
              <DropdownMenuItem
                key={c.name}
                title={c.name}
                onSelect={() => c.name !== context && selectContext(c.name)}
              >
                <ContextAvatar context={c} />
                <span className="flex-1 truncate">{contextLabel(c)}</span>
                {c.name === context && <Check />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => setView("settings")}>
          <Settings />
          Settings
          <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const SETTINGS_PAGES: { page: SettingsPage; label: string; icon: React.ReactNode }[] = [
  { page: "clusters", label: "Clusters", icon: <Server /> },
  { page: "kubeconfig", label: "Kubeconfig files", icon: <FileText /> },
];

function SettingsNav() {
  const { setView, settingsPage, setSettingsPage } = useStore();

  return (
    <>
      <div className="px-3 pb-3">
        <button
          onClick={() => setView("pods")}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground transition-colors duration-100 hover:bg-sidebar-accent hover:text-sidebar-foreground [&_svg]:size-4"
        >
          <ArrowLeft />
          Back to app
        </button>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
        <Section title="Settings">
          {SETTINGS_PAGES.map(({ page, label, icon }) => (
            <NavItem
              key={page}
              icon={icon}
              label={label}
              active={settingsPage === page}
              onClick={() => setSettingsPage(page)}
            />
          ))}
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
        aria-expanded={open}
        className="flex h-6 w-fit items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-sidebar-foreground"
      >
        {title}
        <ChevronDown
          className={cn("size-3 transition-transform duration-200 ease-out-quart", !open && "-rotate-90")}
        />
      </button>
      <Collapsible open={open}>{children}</Collapsible>
    </div>
  );
}

/** Animating grid rows from 1fr to 0fr collapses to the content's real height. */
function Collapsible({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out-quart",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="flex min-h-0 flex-col gap-px overflow-hidden">{children}</div>
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
        "flex h-7 items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-100 hover:bg-sidebar-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
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
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-sidebar-accent hover:text-sidebar-foreground [&_svg]:size-4"
    >
      {children}
    </button>
  );
}
