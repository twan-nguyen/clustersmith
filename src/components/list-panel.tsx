import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, Plus, RotateCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ContextAvatar } from "@/components/context-avatar";
import { NamespaceFilter } from "@/components/namespace-filter";
import { ConfirmDialog } from "@/components/object-menu";
import { Panel, PanelHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { type StatusTone, useNow } from "@/lib/format";
import {
  type ObjectRef,
  type ResourceKind,
  contextLabel,
  deleteResource,
  restartWorkload,
} from "@/lib/kube";
import { templateFor } from "@/lib/templates";
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

/** Keys belong to whatever has focus when it takes text or runs its own keymap. */
function keysAreTaken(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable=true], .xterm, .cm-editor")) {
    return true;
  }
  // An open dialog or menu handles its own keys.
  return Boolean(document.querySelector("[role=dialog], [role=menu]"));
}

/**
 * A live, filterable, sortable list in the main panel. The views only say
 * which columns to show; loading, errors and reconnects look the same everywhere.
 *
 * It is also driven from the keyboard: j/k move, Enter opens the details,
 * x marks rows for a bulk action, e edits YAML and ⌫ deletes.
 */
export function ListPanel<T extends ListRow>({
  icon,
  kind,
  title,
  namespaced,
  columns,
  rows,
  defaultSort = { id: "name", desc: false },
  signature,
  actions,
  onKey,
}: {
  icon: React.ReactNode;
  kind: ResourceKind | undefined;
  title: string;
  namespaced: boolean;
  columns: Column<T>[];
  rows: T[];
  defaultSort?: Sort;
  /** What makes a row flash when it changes. */
  signature: (row: T) => string;
  actions?: (row: T) => React.ReactNode;
  /** Kind-specific single-key shortcuts on the row under the cursor. */
  onKey?: (key: string, row: T) => boolean;
}) {
  const {
    loaded,
    query,
    setQuery,
    error,
    contexts,
    context,
    namespace,
    selectNamespace,
    setView,
    selected,
    select,
    openTab,
  } = useStore();
  const [sort, setSort] = useState<Sort>(defaultSort);
  const [cursor, setCursor] = useState(-1);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [pending, setPending] = useState<"delete" | "restart" | null>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const now = useNow();
  const resource = kind?.id ?? "pods";

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

  // Marks for rows that left the list (deleted, filtered out) are dropped.
  const marked = useMemo(
    () => visible.filter((r) => checked.has(r.uid)),
    [visible, checked],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const ref = (row: T): ObjectRef => ({
    context: context ?? "",
    resource,
    namespace: row.namespace,
    name: row.name,
  });
  const open = (row: T) => select({ ...ref(row), uid: row.uid });

  // Moving the cursor while the details are open shows the new row there.
  function moveTo(index: number) {
    const clamped = Math.max(0, Math.min(visible.length - 1, index));
    if (visible.length === 0) return;
    setCursor(clamped);
    virtualizer.scrollToIndex(clamped);
    if (selected) open(visible[clamped]);
  }

  function toggle(row: T) {
    setChecked((c) => {
      const next = new Set(c);
      if (!next.delete(row.uid)) next.add(row.uid);
      return next;
    });
  }

  function onRowClick(event: React.MouseEvent, index: number) {
    const row = visible[index];
    if (event.shiftKey && anchor !== null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      setChecked((c) => new Set([...c, ...visible.slice(from, to + 1).map((r) => r.uid)]));
    } else if (event.metaKey || event.ctrlKey) {
      toggle(row);
      setAnchor(index);
    } else {
      setAnchor(index);
      open(row);
    }
    setCursor(index);
  }

  // The latest values for the window listener, which is added once.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (keysAreTaken(e.target) || useStore.getState().paletteOpen) return;
    const row = visible[cursor];
    if (e.key === "/") {
      e.preventDefault();
      filterInput.current?.focus();
    } else if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      moveTo(cursor + 1);
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      moveTo(cursor - 1);
    } else if (e.key === "a" && e.metaKey) {
      e.preventDefault();
      setChecked(new Set(visible.map((r) => r.uid)));
    } else if (e.key === "Escape") {
      if (checked.size > 0) setChecked(new Set());
      else if (selected) select(null);
    } else if (!row || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    } else if (e.key === "Enter") {
      open(row);
    } else if (e.key === "x") {
      toggle(row);
      setAnchor(cursor);
    } else if (e.key === "e") {
      openTab({ kind: "yaml", ...ref(row) });
    } else if (e.key === "Backspace" || e.key === "Delete") {
      if (marked.length === 0) setChecked(new Set([row.uid]));
      setPending("delete");
    } else if (onKey?.(e.key, row)) {
      e.preventDefault();
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // The details panel and the cursor agree when a row is opened by click.
  useEffect(() => {
    if (!selected) return;
    const index = visible.findIndex((r) => r.uid === selected.uid);
    if (index !== -1) setCursor(index);
  }, [selected, visible]);

  const grid = { gridTemplateColumns: [...columns.map((c) => c.width), ACTIONS_WIDTH].join(" ") };
  const toggleSort = (id: string) =>
    setSort((s) => ({ id, desc: s.id === id ? !s.desc : false }));

  // The watch reconnects on its own; an error over loaded data is just a dropped stream.
  const reconnecting = Boolean(error) && loaded;

  async function runBulk(action: (ref: ObjectRef) => Promise<void>) {
    const results = await Promise.allSettled(marked.map((row) => action(ref(row))));
    const failed = marked.filter((_, i) => results[i].status === "rejected");
    // What failed stays marked, so it can be retried.
    setChecked(new Set(failed.map((r) => r.uid)));
    if (failed.length > 0) {
      const reasons = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
      throw new Error(failed.map((r, i) => `${r.name}: ${reasons[i]}`).join("\n"));
    }
  }

  const noun = marked.length === 1 ? kind?.singular ?? "object" : title.toLowerCase();

  return (
    // Positioned, so the bulk bar floats at its bottom.
    <Panel className="relative">
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
            ref={filterInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" || e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder="Filter by name"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
          <Kbd>/</Kbd>
        </label>
        {context && (
          <button
            onClick={() =>
              openTab({
                kind: "create",
                context,
                namespace,
                template: templateFor(kind, namespace),
              })
            }
            aria-label={`Create ${kind?.singular ?? "resource"}`}
            title={`Create ${kind?.singular ?? "resource"} from YAML`}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground [&_svg]:size-4"
          >
            <Plus />
          </button>
        )}
      </PanelHeader>

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
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
                    open={selected?.uid === row.uid}
                    cursor={cursor === item.index}
                    checked={checked.has(row.uid)}
                    onClick={(e) => onRowClick(e, item.index)}
                    style={{ ...grid, height: item.size, transform: `translateY(${item.start}px)` }}
                  >
                    {columns.map((c) => (
                      <span key={c.id} className="flex min-w-0 items-center">
                        {c.cell(row, now)}
                      </span>
                    ))}
                    {/* Row buttons act on their own; a click there is not a row click. */}
                    <span
                      onClick={(e) => e.stopPropagation()}
                      className="flex justify-end gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-within:opacity-100 has-data-[state=open]:opacity-100"
                    >
                      {actions?.(row)}
                    </span>
                  </RowView>
                );
              })}
            </div>
          </>
        )}
      </div>

      {marked.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center">
          <div className="pointer-events-auto flex animate-view-in items-center gap-1 rounded-lg border border-border bg-popover py-1 pr-1 pl-3 shadow-lg">
            <span className="mr-2 tabular-nums">{marked.length} selected</span>
            {kind?.restartable && (
              <Button size="sm" variant="ghost" onClick={() => setPending("restart")}>
                <RotateCw />
                Restart
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPending("delete")}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 />
              Delete
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Clear selection"
              title="Clear selection (Esc)"
              onClick={() => setChecked(new Set())}
            >
              <X />
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pending === "delete"}
        onClose={() => setPending(null)}
        title={
          marked.length === 1
            ? `Delete ${noun} "${marked[0].name}"?`
            : `Delete ${marked.length} ${noun}?`
        }
        description={
          resource === "pods"
            ? "Pods owned by a controller are replaced by new ones."
            : "This cannot be undone."
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => runBulk(deleteResource)}
      />
      <ConfirmDialog
        open={pending === "restart"}
        onClose={() => setPending(null)}
        title={`Restart ${marked.length} ${noun}?`}
        description="Pods are replaced one by one, like kubectl rollout restart."
        confirmLabel="Restart"
        onConfirm={() => runBulk(restartWorkload)}
      />
    </Panel>
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
  open,
  cursor,
  checked,
  onClick,
  style,
  children,
}: {
  signature: string;
  /** Shown in the details panel. */
  open: boolean;
  /** Where keyboard actions apply. */
  cursor: boolean;
  /** Marked for a bulk action. */
  checked: boolean;
  onClick: (event: React.MouseEvent) => void;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  const changes = useChangeCount(signature);
  return (
    <div
      onClick={onClick}
      aria-selected={open}
      className={cn(
        "group absolute inset-x-0 top-0 grid cursor-default items-center gap-4 border-b border-border/50 px-5 transition-colors duration-100 select-none hover:bg-accent",
        open && "bg-accent",
        checked && "bg-primary/12 hover:bg-primary/16",
      )}
      style={style}
    >
      {cursor && (
        <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />
      )}
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
        "relative inline-block size-3 shrink-0 rounded-full border-[1.5px] after:absolute after:inset-[2px] after:rounded-full",
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
