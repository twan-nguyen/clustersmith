import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, Box, ScrollText, Search, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { NamespaceFilter } from "@/components/namespace-filter";
import { Panel, PanelHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PodRow } from "@/lib/kube";
import { type StatusTone, formatAge, statusTone, useNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type DockTab, useStore } from "@/store";

type SortKey = "name" | "namespace" | "status" | "restarts" | "age";

const COLUMNS =
  "grid grid-cols-[minmax(220px,2fr)_minmax(120px,1fr)_150px_56px_72px_56px_minmax(110px,1fr)_56px] items-center gap-4 px-5";

const ROW_HEIGHT = 36;

/** Ring color per tone; solid tones also fill the center, like Linear's status icons. */
const TONE_CLASS: Record<StatusTone, string> = {
  ok: "border-success after:bg-success",
  done: "border-muted-foreground after:bg-muted-foreground",
  // A slowly turning dashed ring reads as "in progress", like Linear's icon.
  pending: "border-warning border-dashed animate-spin-slow",
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
        <Box className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="font-medium">Pods</h1>
        <span className="text-muted-foreground tabular-nums">
          {podsLoaded ? rows.length : ""}
        </span>
        {context && <NamespaceFilter />}
        {reconnecting && (
          <span
            title={error ?? undefined}
            className="flex h-6 animate-fade-in items-center gap-1.5 rounded-md px-2 text-xs text-warning"
          >
            <span className="size-1.5 animate-pulse rounded-full bg-warning motion-reduce:animate-none" />
            Reconnecting…
          </span>
        )}
        <label className="ml-auto flex h-7 w-60 items-center gap-2 rounded-md px-2 text-muted-foreground transition-colors duration-100 hover:bg-accent focus-within:bg-accent">
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
          <SkeletonRows />
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
              <span className="sr-only">Actions</span>
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

/**
 * Counts changes to what an operator watches for, so the row can flash. The
 * first render never counts: rows also mount when scrolled into view.
 */
function useChangeCount(pod: PodRow) {
  const signature = `${pod.status}|${pod.restarts}|${pod.ready}`;
  const previous = useRef(signature);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;
    setCount((c) => c + 1);
  }, [signature]);
  return count;
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
  const changes = useChangeCount(pod);
  return (
    <div
      className={cn(
        COLUMNS,
        "group absolute inset-x-0 top-0 border-b border-border/50 transition-colors duration-100 hover:bg-accent",
      )}
      style={style}
    >
      {changes > 0 && (
        // Remounting by key restarts the fade for every new change.
        <span
          key={changes}
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-row-flash bg-primary/12"
        />
      )}
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
      <span className="flex justify-end gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-within:opacity-100 has-data-[state=open]:opacity-100">
        <PodAction pod={pod} kind="logs" label="Logs" icon={<ScrollText />} />
        <PodAction pod={pod} kind="shell" label="Shell" icon={<SquareTerminal />} />
      </span>
    </div>
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
  kind: DockTab["kind"];
  label: string;
  icon: React.ReactNode;
}) {
  const { context, openTab } = useStore();
  if (!context) return null;
  const open = (container: string | null) =>
    openTab(kind, { context, namespace: pod.namespace, pod: pod.name, container });

  const buttonClass =
    "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-foreground/10 hover:text-foreground data-[state=open]:bg-foreground/10 [&_svg]:size-3.5";

  if (pod.containerNames.length <= 1) {
    return (
      <button aria-label={`${label}: ${pod.name}`} title={label} onClick={() => open(null)} className={buttonClass}>
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
  const active = sort.key === column;
  return (
    <button
      onClick={() => onSort(column)}
      className={cn(
        "flex items-center gap-1 text-left transition-colors duration-100 hover:text-foreground",
        active && "text-foreground",
      )}
    >
      {label}
      {active && (
        <ArrowUp
          className={cn(
            "size-3 animate-fade-in transition-transform duration-150 ease-out-quart",
            sort.desc && "rotate-180",
          )}
        />
      )}
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
    <div className="flex animate-fade-in flex-col items-center gap-1 px-8 py-24 text-center">
      <div className="font-medium">{title}</div>
      {detail && <div className="max-w-md break-words text-muted-foreground">{detail}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Placeholder rows shaped like the table while the first snapshot loads. */
const SKELETON_WIDTHS = ["72%", "58%", "80%", "64%", "76%", "52%", "68%", "60%"];

function SkeletonRows() {
  return (
    <div aria-label="Loading pods" role="status" className="animate-fade-in">
      {SKELETON_WIDTHS.map((width, i) => (
        <div
          key={i}
          className={cn(COLUMNS, "border-b border-border/50")}
          style={{ height: ROW_HEIGHT }}
        >
          <span className="h-3 animate-pulse rounded bg-muted-foreground/15" style={{ width }} />
          <span className="h-3 w-3/5 animate-pulse rounded bg-muted-foreground/10" />
          <span className="h-3 w-2/5 animate-pulse rounded bg-muted-foreground/10" />
          <span className="h-3 w-6 animate-pulse rounded bg-muted-foreground/10" />
          <span className="h-3 w-4 animate-pulse rounded bg-muted-foreground/10" />
          <span className="h-3 w-6 animate-pulse rounded bg-muted-foreground/10" />
          <span className="h-3 w-1/2 animate-pulse rounded bg-muted-foreground/10" />
        </div>
      ))}
    </div>
  );
}
