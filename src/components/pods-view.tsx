import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Box, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { NamespaceFilter } from "@/components/namespace-filter";
import { Panel, PanelHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import type { PodRow } from "@/lib/kube";
import { type StatusTone, formatAge, statusTone, useNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

type SortKey = "name" | "namespace" | "status" | "restarts" | "age";

const COLUMNS =
  "grid grid-cols-[minmax(220px,2fr)_minmax(120px,1fr)_150px_56px_72px_56px_minmax(110px,1fr)] items-center gap-4 px-5";

const ROW_HEIGHT = 36;

/** Ring color per tone; solid tones also fill the center, like Linear's status icons. */
const TONE_CLASS: Record<StatusTone, string> = {
  ok: "border-success after:bg-success",
  done: "border-muted-foreground after:bg-muted-foreground",
  pending: "border-warning border-dashed",
  failed: "border-destructive after:bg-destructive",
  unknown: "border-muted-foreground/60",
};

const compare: Record<SortKey, (a: PodRow, b: PodRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  namespace: (a, b) => a.namespace.localeCompare(b.namespace),
  status: (a, b) => a.status.localeCompare(b.status),
  restarts: (a, b) => a.restarts - b.restarts,
  // Newest first reads as "smallest age first".
  age: (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
};

export function PodsView() {
  const {
    pods,
    podsLoaded,
    query,
    setQuery,
    error,
    context,
    namespace,
    selectNamespace,
    setView,
  } = useStore();
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "name",
    desc: false,
  });
  const now = useNow();

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? pods.filter(
          (p) => p.name.toLowerCase().includes(needle) || p.namespace.includes(needle),
        )
      : pods;
    const sorted = [...filtered].sort(compare[sort.key]);
    return sort.desc ? sorted.reverse() : sorted;
  }, [pods, query, sort]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const toggleSort = (key: SortKey) =>
    setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }));
  const retry = () => selectNamespace(namespace);

  // The watch reconnects on its own; an error over loaded data is just a dropped stream.
  const reconnecting = Boolean(error) && podsLoaded;

  return (
    <Panel>
      <PanelHeader>
        <Box className="size-4 text-muted-foreground" />
        <h1 className="font-medium">Pods</h1>
        <span className="text-muted-foreground tabular-nums">
          {podsLoaded ? rows.length : ""}
        </span>
        {context && <NamespaceFilter />}
        {reconnecting && (
          <span
            title={error ?? undefined}
            className="flex h-6 items-center gap-1.5 rounded-md px-2 text-xs text-warning"
          >
            <span className="size-1.5 animate-pulse rounded-full bg-warning motion-reduce:animate-none" />
            Reconnecting…
          </span>
        )}
        <label className="ml-auto flex h-7 w-60 items-center gap-2 rounded-md px-2 text-muted-foreground hover:bg-accent focus-within:bg-accent">
          <Search className="size-3.5" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </PanelHeader>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {!context ? (
          <Empty
            title="No clusters yet"
            detail="Add a kubeconfig file in Settings to see its clusters here."
            action={<Button onClick={() => setView("settings")}>Open Settings</Button>}
          />
        ) : error && !podsLoaded ? (
          <Empty
            title="Can't load pods"
            detail={error}
            action={
              <Button variant="outline" onClick={retry}>
                Retry
              </Button>
            }
          />
        ) : !podsLoaded ? (
          <Empty title="Loading pods…" />
        ) : rows.length === 0 ? (
          <Empty title="No pods" detail={query ? "Nothing matches this filter." : undefined} />
        ) : (
          <>
            <div
              className={cn(
                COLUMNS,
                "sticky top-0 z-10 h-8 border-b border-border bg-card text-xs text-muted-foreground",
              )}
            >
              <SortHeader label="Name" column="name" sort={sort} onSort={toggleSort} />
              <SortHeader label="Namespace" column="namespace" sort={sort} onSort={toggleSort} />
              <SortHeader label="Status" column="status" sort={sort} onSort={toggleSort} />
              <span>Ready</span>
              <SortHeader label="Restarts" column="restarts" sort={sort} onSort={toggleSort} />
              <SortHeader label="Age" column="age" sort={sort} onSort={toggleSort} />
              <span>Node</span>
            </div>
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => (
                <PodRowView
                  key={rows[item.index].uid}
                  pod={rows[item.index]}
                  now={now}
                  style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

function PodRowView({
  pod,
  now,
  style,
}: {
  pod: PodRow;
  now: number;
  style: React.CSSProperties;
}) {
  return (
    <div
      className={cn(COLUMNS, "absolute inset-x-0 top-0 border-b border-border/50 hover:bg-accent")}
      style={style}
    >
      <span className="truncate">{pod.name}</span>
      <span className="truncate text-muted-foreground">{pod.namespace}</span>
      <span className="flex items-center gap-2 truncate">
        <StatusIcon tone={statusTone(pod.status)} />
        <span className="truncate">{pod.status}</span>
      </span>
      <span className="text-muted-foreground tabular-nums">
        {pod.ready}/{pod.containers}
      </span>
      <span
        className={cn("tabular-nums", pod.restarts > 0 ? "text-warning" : "text-muted-foreground")}
      >
        {pod.restarts}
      </span>
      <span className="text-muted-foreground tabular-nums">{formatAge(pod.createdAt, now)}</span>
      <span className="truncate text-muted-foreground">{pod.node ?? "—"}</span>
    </div>
  );
}

function StatusIcon({ tone }: { tone: StatusTone }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative size-3 shrink-0 rounded-full border-[1.5px] after:absolute after:inset-[2px] after:rounded-full",
        TONE_CLASS[tone],
      )}
    />
  );
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; desc: boolean };
  onSort: (key: SortKey) => void;
}) {
  const Arrow = sort.desc ? ArrowDown : ArrowUp;
  return (
    <button
      onClick={() => onSort(column)}
      className={cn(
        "flex items-center gap-1 text-left hover:text-foreground",
        sort.key === column && "text-foreground",
      )}
    >
      {label}
      {sort.key === column && <Arrow className="size-3" />}
    </button>
  );
}

function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-8 py-24 text-center">
      <div className="font-medium">{title}</div>
      {detail && <div className="max-w-md break-words text-muted-foreground">{detail}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
