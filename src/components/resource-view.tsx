import { useMemo } from "react";

import { KindIcon } from "@/components/kind-icon";
import { type Column, ListPanel, StatusIcon } from "@/components/list-panel";
import { ObjectMenu } from "@/components/object-menu";
import { formatAge, formatBytes, formatCpu } from "@/lib/format";
import type { ResourceKind, ResourceRow, Usage } from "@/lib/kube";
import { useMetrics } from "@/lib/use-metrics";
import { useStore } from "@/store";

/** Numbers sort as numbers ("10" after "9"); everything else alphabetically. */
function compareCells(a: string, b: string) {
  const [x, y] = [Number(a), Number(b)];
  if (a !== "" && b !== "" && !Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  return a.localeCompare(b);
}

// Times sort newest first, which reads as "smallest age first".
const newestFirst = (a: string | null, b: string | null) => (b ?? "").localeCompare(a ?? "");

function columnsFor(kind: ResourceKind): Column<ResourceRow>[] {
  const columns: Column<ResourceRow>[] = [
    {
      id: "name",
      label: "Name",
      width: "minmax(200px,2fr)",
      sort: (a, b) => a.name.localeCompare(b.name),
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          {r.tone && <StatusIcon tone={r.tone} />}
          <span className="truncate">{r.name}</span>
        </span>
      ),
    },
  ];
  if (kind.namespaced) {
    columns.push({
      id: "namespace",
      label: "Namespace",
      width: "minmax(110px,1fr)",
      sort: (a, b) => (a.namespace ?? "").localeCompare(b.namespace ?? ""),
      cell: (r) => <span className="truncate text-muted-foreground">{r.namespace}</span>,
    });
  }
  kind.columns.forEach((column, i) => {
    columns.push({
      id: `cell-${i}`,
      label: column.label,
      width: column.label === "Message" ? "minmax(240px,3fr)" : "minmax(72px,1fr)",
      sort: column.time
        ? (a, b) => newestFirst(a.cells[i], b.cells[i])
        : (a, b) => compareCells(a.cells[i], b.cells[i]),
      cell: (r, now) => (
        <span className="truncate text-muted-foreground tabular-nums" title={r.cells[i]}>
          {column.time ? formatAge(r.cells[i] || null, now) : r.cells[i]}
        </span>
      ),
    });
  });
  columns.push({
    id: "age",
    label: kind.ageLabel,
    width: "72px",
    sort: (a, b) => newestFirst(a.age, b.age),
    cell: (r, now) => (
      <span className="text-muted-foreground tabular-nums">{formatAge(r.age, now)}</span>
    ),
  });
  return columns;
}

/** A node's usage against what it can give, as a figure and a thin bar. */
function UsageCell({ used, total, format }: { used: number; total?: number; format: (n: number) => string }) {
  const share = total ? Math.min(1, used / total) : null;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 tabular-nums">
      <span className="w-10 shrink-0 text-muted-foreground">{format(used)}</span>
      {share !== null && (
        <span className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-muted" title={`${Math.round(share * 100)}%`}>
          <span
            className={share > 0.85 ? "block h-full bg-destructive" : share > 0.65 ? "block h-full bg-warning" : "block h-full bg-success"}
            style={{ width: `${share * 100}%` }}
          />
        </span>
      )}
    </span>
  );
}

function nodeUsageColumns(metrics: Record<string, Usage>): Column<ResourceRow>[] {
  return [
    {
      id: "cpu",
      label: "CPU",
      width: "minmax(110px,1fr)",
      sort: (a, b) => (metrics[a.name]?.cpu ?? -1) - (metrics[b.name]?.cpu ?? -1),
      cell: (r) => {
        const u = metrics[r.name];
        return u ? <UsageCell used={u.cpu} total={u.cpuAllocatable} format={formatCpu} /> : "—";
      },
    },
    {
      id: "memory",
      label: "Memory",
      width: "minmax(110px,1fr)",
      sort: (a, b) => (metrics[a.name]?.memory ?? -1) - (metrics[b.name]?.memory ?? -1),
      cell: (r) => {
        const u = metrics[r.name];
        return u ? <UsageCell used={u.memory} total={u.memoryAllocatable} format={formatBytes} /> : "—";
      },
    },
  ];
}

/** "2/3" in a Ready column means 3 desired replicas. */
function desiredReplicas(row: ResourceRow) {
  const desired = Number(row.cells[0]?.split("/")[1]);
  return Number.isInteger(desired) ? desired : undefined;
}

/** Any kind from the sidebar other than Pods, laid out from its column spec. */
export function ResourceView({ kind }: { kind: ResourceKind }) {
  const { resources, context } = useStore();
  // Only nodes have usage among these kinds; pods have their own view.
  const metrics = useMetrics("nodes", kind.id === "nodes");
  const columns = useMemo(() => {
    const base = columnsFor(kind);
    if (kind.id !== "nodes" || !metrics) return base;
    return [...base.slice(0, -1), ...nodeUsageColumns(metrics), ...base.slice(-1)];
  }, [kind, metrics]);

  return (
    <ListPanel
      icon={<KindIcon kind={kind.id} />}
      kind={kind}
      title={kind.label}
      namespaced={kind.namespaced}
      columns={columns}
      rows={resources}
      // Events matter by recency, everything else by name.
      defaultSort={kind.id === "events" ? { id: "age", desc: false } : undefined}
      signature={(r) => `${r.tone}|${r.cells.join("|")}`}
      actions={(row) =>
        context && (
          <ObjectMenu
            object={{ context, resource: kind.id, namespace: row.namespace, name: row.name }}
            kind={kind}
            replicas={kind.scalable ? desiredReplicas(row) : undefined}
            cordoned={kind.id === "nodes" ? row.cells[0]?.includes("SchedulingDisabled") : undefined}
          />
        )
      }
    />
  );
}
