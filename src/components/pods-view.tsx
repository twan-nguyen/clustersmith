import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Kbd } from "@/components/ui/kbd";
import type { PodRow } from "@/lib/kube";
import { type StatusTone, formatAge, statusTone, useNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

type SortKey = "name" | "namespace" | "status" | "restarts" | "age";

const COLUMNS =
  "grid grid-cols-[minmax(220px,2fr)_minmax(120px,1fr)_150px_64px_76px_56px_minmax(120px,1fr)] items-center gap-3 px-4";

const ROW_HEIGHT = 36;

const TONE_CLASS: Record<StatusTone, string> = {
  ok: "bg-success",
  done: "bg-muted-foreground",
  pending: "bg-warning",
  failed: "bg-destructive",
  unknown: "bg-muted-foreground/50",
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
  const { pods, podsLoaded, query, setQuery, error, context, setPaletteOpen } = useStore();
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

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4"
      >
        <h1 className="font-medium">Pods</h1>
        <span className="text-muted-foreground tabular-nums">
          {podsLoaded ? rows.length : "…"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex h-7 w-64 items-center gap-2 rounded-md border border-input bg-muted px-2 focus-within:border-ring">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter pods"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </label>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex h-7 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-accent"
          >
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </button>
        </div>
      </header>

      {error && (
        <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-destructive">
          {error}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div
          className={cn(
            COLUMNS,
            "sticky top-0 z-10 h-8 border-b border-border bg-background text-xs text-muted-foreground",
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

        {!context ? (
          <Empty
            title="No kubeconfig found"
            detail="ClusterSmith reads ~/.kube/config or the file set in $KUBECONFIG."
          />
        ) : podsLoaded && rows.length === 0 ? (
          <Empty title="No pods" detail={query ? "Nothing matches this filter." : undefined} />
        ) : (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const pod = rows[item.index];
              return (
                <div
                  key={pod.uid}
                  className={cn(
                    COLUMNS,
                    "absolute inset-x-0 top-0 border-b border-border/60 hover:bg-accent/60",
                  )}
                  style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  <span className="truncate font-medium">{pod.name}</span>
                  <span className="truncate text-muted-foreground">{pod.namespace}</span>
                  <span className="flex items-center gap-2 truncate">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        TONE_CLASS[statusTone(pod.status)],
                      )}
                    />
                    <span className="truncate">{pod.status}</span>
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {pod.ready}/{pod.containers}
                  </span>
                  <span
                    className={cn(
                      "tabular-nums",
                      pod.restarts > 0 ? "text-warning" : "text-muted-foreground",
                    )}
                  >
                    {pod.restarts}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatAge(pod.createdAt, now)}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {pod.node ?? "—"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
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
      className="flex items-center gap-1 text-left hover:text-foreground"
    >
      {label}
      {sort.key === column && <Arrow className="size-3" />}
    </button>
  );
}

function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 py-24 text-center">
      <div className="font-medium">{title}</div>
      {detail && <div className="text-muted-foreground">{detail}</div>}
    </div>
  );
}
