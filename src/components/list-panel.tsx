import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ContextAvatar } from "@/components/context-avatar";
import { NamespaceFilter } from "@/components/namespace-filter";
import { Panel, PanelHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { type StatusTone, useNow } from "@/lib/format";
import { contextLabel } from "@/lib/kube";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

const ROW_HEIGHT = 36;

/** Width of the trailing column that holds row actions. */
const ACTIONS_WIDTH = "84px";

export type Column<T> = {
  id: string;
  label: string;
  /** A CSS grid track, such as `minmax(120px,1fr)` or `64px`. */
  width: string;
  /** Present when the column can be sorted by clicking its header. */
  sort?: (a: T, b: T) => number;
  cell: (row: T, now: number) => React.ReactNode;
};

type Sort = { id: string; desc: boolean };

type ListRow = { uid: string; name: string; namespace: string | null };

/**
 * A live, filterable, sortable list in the main panel. The views only say
 * which columns to show; loading, errors and reconnects look the same everywhere.
 */
export function ListPanel<T extends ListRow>({
  icon,
  title,
  namespaced,
  columns,
  rows,
  defaultSort = { id: "name", desc: false },
  signature,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  namespaced: boolean;
  columns: Column<T>[];
  rows: T[];
  defaultSort?: Sort;
  /** What makes a row flash when it changes. */
  signature: (row: T) => string;
  actions?: (row: T) => React.ReactNode;
}) {
  const { loaded, query, setQuery, error, contexts, context, namespace, selectNamespace, setView } =
    useStore();
  const [sort, setSort] = useState<Sort>(defaultSort);
  const now = useNow();

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(needle) || r.namespace?.toLowerCase().includes(needle),
        )
      : rows;
    const compare = columns.find((c) => c.id === sort.id)?.sort;
    if (!compare) return filtered;
    const sorted = [...filtered].sort(compare);
    return sort.desc ? sorted.reverse() : sorted;
  }, [rows, query, sort, columns]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const grid = { gridTemplateColumns: [...columns.map((c) => c.width), ACTIONS_WIDTH].join(" ") };
  const toggleSort = (id: string) =>
    setSort((s) => ({ id, desc: s.id === id ? !s.desc : false }));

  // The watch reconnects on its own; an error over loaded data is just a dropped stream.
  const reconnecting = Boolean(error) && loaded;

  return (
    <Panel>
      <PanelHeader>
        <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
        <h1 className="font-medium">{title}</h1>
        <span className="text-muted-foreground tabular-nums">{loaded ? visible.length : ""}</span>
        {context && namespaced && <NamespaceFilter />}
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
        {!context && contexts.length > 0 ? (
          <Empty
            title="Choose a cluster"
            detail="ClusterSmith connects only to the cluster you pick."
            action={<ClusterPicker />}
          />
        ) : !context ? (
          <Empty
            title="No clusters yet"
            detail="Add a kubeconfig file in Settings to see its clusters here."
            action={<Button onClick={() => setView("settings")}>Open Settings</Button>}
          />
        ) : error && !loaded ? (
          <Empty
            title={`Can't load ${title.toLowerCase()}`}
            detail={error}
            action={
              <Button variant="outline" onClick={() => selectNamespace(namespace)}>
                Retry
              </Button>
            }
          />
        ) : !loaded ? (
          <SkeletonRows grid={grid} columns={columns.length} label={`Loading ${title}`} />
        ) : visible.length === 0 ? (
          <Empty
            title={`No ${title.toLowerCase()}`}
            detail={query ? "Nothing matches this filter." : undefined}
          />
        ) : (
          <>
            <div
              className="sticky top-0 z-10 grid h-8 items-center gap-4 border-b border-border bg-card px-5 text-xs text-muted-foreground"
              style={grid}
            >
              {columns.map((c) =>
                c.sort ? (
                  <SortHeader key={c.id} label={c.label} column={c.id} sort={sort} onSort={toggleSort} />
                ) : (
                  <span key={c.id} className="truncate">
                    {c.label}
                  </span>
                ),
              )}
              <span className="sr-only">Actions</span>
            </div>
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = visible[item.index];
                return (
                  <RowView
                    key={row.uid}
                    signature={signature(row)}
                    style={{ ...grid, height: item.size, transform: `translateY(${item.start}px)` }}
                  >
                    {columns.map((c) => (
                      <span key={c.id} className="flex min-w-0 items-center">
                        {c.cell(row, now)}
                      </span>
                    ))}
                    <span className="flex justify-end gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-within:opacity-100 has-data-[state=open]:opacity-100">
                      {actions?.(row)}
                    </span>
                  </RowView>
                );
              })}
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
function useChangeCount(signature: string) {
  const previous = useRef(signature);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;
    setCount((c) => c + 1);
  }, [signature]);
  return count;
}

function RowView({
  signature,
  style,
  children,
}: {
  signature: string;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  const changes = useChangeCount(signature);
  return (
    <div
      className="group absolute inset-x-0 top-0 grid items-center gap-4 border-b border-border/50 px-5 transition-colors duration-100 hover:bg-accent"
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
      {children}
    </div>
  );
}

/** Ring color per tone; solid tones also fill the center, like Linear's status icons. */
const TONE_CLASS: Record<StatusTone, string> = {
  ok: "border-success after:bg-success",
  done: "border-muted-foreground after:bg-muted-foreground",
  // A slowly turning dashed ring reads as "in progress", like Linear's icon.
  pending: "border-warning border-dashed animate-spin-slow",
  failed: "border-destructive after:bg-destructive",
  unknown: "border-muted-foreground/60",
};

export function StatusIcon({ tone }: { tone: StatusTone }) {
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
  column: string;
  sort: Sort;
  onSort: (id: string) => void;
}) {
  const active = sort.id === column;
  return (
    <button
      onClick={() => onSort(column)}
      className={cn(
        "flex min-w-0 items-center gap-1 text-left transition-colors duration-100 hover:text-foreground",
        active && "text-foreground",
      )}
    >
      <span className="truncate">{label}</span>
      {active && (
        <ArrowUp
          className={cn(
            "size-3 shrink-0 animate-fade-in transition-transform duration-150 ease-out-quart",
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

function ClusterPicker() {
  const { contexts, selectContext } = useStore();
  return (
    <div className="flex w-72 flex-col gap-1">
      {contexts.map((c) => (
        <button
          key={c.name}
          onClick={() => selectContext(c.name)}
          title={c.name}
          className="flex h-9 items-center gap-2.5 rounded-md border border-border px-3 text-left transition-colors duration-100 hover:bg-accent"
        >
          <ContextAvatar context={c} />
          <span className="flex-1 truncate">{contextLabel(c)}</span>
          {contextLabel(c) !== c.name && (
            <span className="max-w-28 truncate text-xs text-muted-foreground">{c.name}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Placeholder rows shaped like the table while the first snapshot loads. */
const SKELETON_WIDTHS = ["72%", "58%", "80%", "64%", "76%", "52%", "68%", "60%"];

function SkeletonRows({
  grid,
  columns,
  label,
}: {
  grid: React.CSSProperties;
  columns: number;
  label: string;
}) {
  return (
    <div aria-label={label} role="status" className="animate-fade-in">
      {SKELETON_WIDTHS.map((width, i) => (
        <div
          key={i}
          className="grid items-center gap-4 border-b border-border/50 px-5"
          style={{ ...grid, height: ROW_HEIGHT }}
        >
          {Array.from({ length: columns }, (_, c) => (
            <span
              key={c}
              className={cn(
                "h-3 animate-pulse rounded",
                c === 0 ? "bg-muted-foreground/15" : "bg-muted-foreground/10",
              )}
              style={{ width: c === 0 ? width : "50%" }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
