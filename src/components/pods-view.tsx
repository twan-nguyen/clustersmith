import { Box, ScrollText, SquareTerminal } from "lucide-react";

import { type Column, ListPanel, StatusIcon } from "@/components/list-panel";
import { ObjectMenu } from "@/components/object-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatAge, statusTone } from "@/lib/format";
import type { PodRow } from "@/lib/kube";
import { cn } from "@/lib/utils";
import { type PodTab, useStore } from "@/store";

const COLUMNS: Column<PodRow>[] = [
  {
    id: "name",
    label: "Name",
    width: "minmax(220px,2fr)",
    sort: (a, b) => a.name.localeCompare(b.name),
    cell: (p) => <span className="truncate">{p.name}</span>,
  },
  {
    id: "namespace",
    label: "Namespace",
    width: "minmax(120px,1fr)",
    sort: (a, b) => a.namespace.localeCompare(b.namespace),
    cell: (p) => <span className="truncate text-muted-foreground">{p.namespace}</span>,
  },
  {
    id: "status",
    label: "Status",
    width: "150px",
    sort: (a, b) => a.status.localeCompare(b.status),
    cell: (p) => (
      <span className="flex min-w-0 items-center gap-2">
        <StatusIcon tone={statusTone(p.status)} />
        <span className="truncate">{p.status}</span>
      </span>
    ),
  },
  {
    id: "ready",
    label: "Ready",
    width: "56px",
    cell: (p) => (
      <span className="text-muted-foreground tabular-nums">
        {p.ready}/{p.containers}
      </span>
    ),
  },
  {
    id: "restarts",
    label: "Restarts",
    width: "72px",
    sort: (a, b) => a.restarts - b.restarts,
    cell: (p) => (
      <span className={cn("tabular-nums", p.restarts > 0 ? "text-warning" : "text-muted-foreground")}>
        {p.restarts}
      </span>
    ),
  },
  {
    id: "age",
    label: "Age",
    width: "56px",
    // Newest first reads as "smallest age first".
    sort: (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
    cell: (p, now) => (
      <span className="text-muted-foreground tabular-nums">{formatAge(p.createdAt, now)}</span>
    ),
  },
  {
    id: "node",
    label: "Node",
    width: "minmax(110px,1fr)",
    cell: (p) => <span className="truncate text-muted-foreground">{p.node ?? "—"}</span>,
  },
];

export function PodsView() {
  const { pods, kinds, context } = useStore();
  const podKind = kinds.find((k) => k.id === "pods");

  return (
    <ListPanel
      icon={<Box />}
      title="Pods"
      namespaced
      columns={COLUMNS}
      rows={pods}
      signature={(p) => `${p.status}|${p.restarts}|${p.ready}`}
      actions={(pod) =>
        context && (
          <>
            <PodAction pod={pod} kind="logs" label="Logs" icon={<ScrollText />} />
            <PodAction pod={pod} kind="shell" label="Shell" icon={<SquareTerminal />} />
            <ObjectMenu
              object={{ context, resource: "pods", namespace: pod.namespace, name: pod.name }}
              kind={podKind}
            />
          </>
        )
      }
    />
  );
}

/** Opens logs or a shell in the dock; asks which container when there are several. */
function PodAction({
  pod,
  kind,
  label,
  icon,
}: {
  pod: PodRow;
  kind: PodTab["kind"];
  label: string;
  icon: React.ReactNode;
}) {
  const { context, openTab } = useStore();
  if (!context) return null;
  const open = (container: string | null) =>
    openTab({ kind, context, namespace: pod.namespace, pod: pod.name, container });

  const buttonClass =
    "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-foreground/10 hover:text-foreground data-[state=open]:bg-foreground/10 [&_svg]:size-3.5";

  if (pod.containerNames.length <= 1) {
    return (
      <button
        aria-label={`${label}: ${pod.name}`}
        title={label}
        onClick={() => open(null)}
        className={buttonClass}
      >
        {icon}
      </button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button aria-label={`${label}: ${pod.name}`} title={label} className={buttonClass}>
          {icon}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{label} · container</DropdownMenuLabel>
        {pod.containerNames.map((name) => (
          <DropdownMenuItem key={name} onSelect={() => open(name)}>
            {icon}
            <span className="truncate">{name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
