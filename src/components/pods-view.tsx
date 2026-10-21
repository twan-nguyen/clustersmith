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
import { useMemo } from "react";

import { formatAge, formatBytes, formatCpu, statusTone } from "@/lib/format";
import type { PodRow, Usage } from "@/lib/kube";
import { useMetrics } from "@/lib/use-metrics";
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

/** CPU and memory columns, added once metrics-server answers. */
function usageColumns(metrics: Record<string, Usage>): Column<PodRow>[] {
  const usage = (p: PodRow) => metrics[`${p.namespace}/${p.name}`];
  return [
    {
      id: "cpu",
      label: "CPU",
      width: "64px",
      sort: (a, b) => (usage(a)?.cpu ?? -1) - (usage(b)?.cpu ?? -1),
      cell: (p) => {
        const u = usage(p);
        return <span className="text-muted-foreground tabular-nums">{u ? formatCpu(u.cpu) : "—"}</span>;
      },
    },
    {
      id: "memory",
      label: "Memory",
      width: "72px",
      sort: (a, b) => (usage(a)?.memory ?? -1) - (usage(b)?.memory ?? -1),
      cell: (p) => {
        const u = usage(p);
        return (
          <span className="text-muted-foreground tabular-nums">{u ? formatBytes(u.memory) : "—"}</span>
        );
      },
    },
  ];
}

export function PodsView() {
  const { pods, kinds, context, openTab } = useStore();
  const podKind = kinds.find((k) => k.id === "pods");
  const metrics = useMetrics("pods");
  const columns = useMemo(() => {
    if (!metrics) return COLUMNS;
    // Usage reads best next to restarts, before age and node.
    const at = COLUMNS.findIndex((c) => c.id === "age");
    return [...COLUMNS.slice(0, at), ...usageColumns(metrics), ...COLUMNS.slice(at)];
  }, [metrics]);

  // l: logs, s: shell, p: the previous run's logs; all in the default container.
  function onKey(key: string, pod: PodRow) {
    const kind = { l: "logs", s: "shell", p: "logs" }[key] as PodTab["kind"] | undefined;
    if (!kind || !context) return false;
    const target = { context, namespace: pod.namespace, pod: pod.name, container: null };
    openTab({ kind, ...target, previous: key === "p" });
    return true;
  }

  return (
    <ListPanel
      icon={<Box />}
      kind={podKind}
      title="Pods"
      namespaced
      columns={columns}
      rows={pods}
      onKey={onKey}
      signature={(p) => `${p.status}|${p.restarts}|${p.ready}`}
      actions={(pod) =>
        context && (
          <>
            <PodAction pod={pod} kind="logs" label="Logs" icon={<ScrollText />} />
            <PodAction pod={pod} kind="shell" label="Shell" icon={<SquareTerminal />} />
            <ObjectMenu
              object={{ context, resource: "pods", namespace: pod.namespace, name: pod.name }}
              kind={podKind}
              containers={pod.containerNames}
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
