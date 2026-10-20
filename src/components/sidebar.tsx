import { Box, Check, ChevronsUpDown, Layers } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

export function Sidebar() {
  const { contexts, context, namespaces, namespace, selectContext, selectNamespace } =
    useStore();
  const active = contexts.find((c) => c.name === context);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Leaves room for the macOS traffic lights and lets the window be dragged. */}
      <div data-tauri-drag-region className="h-11 shrink-0" />

      <div className="px-2 pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent">
              <span className="flex size-5 items-center justify-center rounded bg-primary text-[10px] font-semibold text-primary-foreground">
                {(context ?? "?").slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {context ?? "No context"}
                </span>
                {active && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {active.cluster}
                  </span>
                )}
              </span>
              <ChevronsUpDown className="size-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Contexts</DropdownMenuLabel>
            {contexts.map((c) => (
              <DropdownMenuItem key={c.name} onSelect={() => selectContext(c.name)}>
                <span className="flex-1 truncate">{c.name}</span>
                {c.name === context && <Check className="size-3.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3">
        <Section title="Workloads">
          <NavItem icon={<Box className="size-3.5" />} label="Pods" active />
        </Section>

        <Section title="Namespaces">
          <NavItem
            icon={<Layers className="size-3.5" />}
            label="All namespaces"
            active={namespace === null}
            onClick={() => selectNamespace(null)}
          />
          {namespaces.map((ns) => (
            <NavItem
              key={ns}
              label={ns}
              active={namespace === ns}
              onClick={() => selectNamespace(ns)}
            />
          ))}
        </Section>
      </nav>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-px">
      <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-2 rounded-md px-2 text-left text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
        active && "bg-sidebar-accent text-sidebar-foreground",
      )}
    >
      {icon ?? <span className="size-3.5" />}
      <span className="truncate">{label}</span>
    </button>
  );
}
