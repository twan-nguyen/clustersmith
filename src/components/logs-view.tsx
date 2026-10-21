import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { closeSession, openLogs } from "@/lib/kube";
import { cn, errorMessage } from "@/lib/utils";
import type { DockTab } from "@/store";

/** Oldest lines are dropped past this, so a long session stays light. */
const MAX_LINES = 20_000;
const LINE_HEIGHT = 18;

// Color and cursor escape codes; logs are shown as plain text.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

type Status =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "ended" }
  | { kind: "error"; message: string };

export function LogsView({ tab, active }: { tab: DockTab; active: boolean }) {
  const lines = useRef<string[]>([]);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    let id: number | null = null;
    let cancelled = false;
    openLogs(tab, (event) => {
      if (cancelled) return;
      if (event.type === "lines") {
        const buffer = lines.current;
        for (const line of event.lines) buffer.push(line.replace(ANSI, ""));
        if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
        setVersion((v) => v + 1);
      } else if (event.type === "ended") {
        setStatus({ kind: "ended" });
      } else {
        setStatus({ kind: "error", message: event.message });
      }
    })
      .then((sessionId) => {
        // The tab may have closed while the stream was opening.
        if (cancelled) return closeSession(sessionId);
        id = sessionId;
        setStatus((s) => (s.kind === "connecting" ? { kind: "live" } : s));
      })
      .catch((err) => !cancelled && setStatus({ kind: "error", message: errorMessage(err) }));

    return () => {
      cancelled = true;
      if (id !== null) closeSession(id);
    };
  }, [tab]);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? lines.current.filter((l) => l.toLowerCase().includes(needle)) : lines.current;
    // `version` bumps whenever the shared buffer grows.
  }, [filter, version]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
  });

  useEffect(() => {
    if (follow && active && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    }
  }, [follow, active, rows.length, version, virtualizer]);

  // Scrolling up to read pauses following; scrolling back to the end resumes it.
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < LINE_HEIGHT * 2;
    if (atEnd !== follow) setFollow(atEnd);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-xs">
        <label className="flex h-6 w-56 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground transition-colors duration-100 hover:bg-accent focus-within:bg-accent">
          <Search className="size-3.5" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter lines"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <span className="text-muted-foreground tabular-nums">
          {filter ? `${rows.length} of ${lines.current.length}` : lines.current.length} lines
        </span>
        <StatusLabel status={status} />
        <button
          onClick={() => setFollow(!follow)}
          aria-pressed={follow}
          title="Follow new lines"
          className={cn(
            "ml-auto flex h-6 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground",
            follow && "text-foreground",
          )}
        >
          <ArrowDownToLine className="size-3.5" />
          Follow
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto font-mono text-xs select-text"
      >
        <div className="relative w-max min-w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.index}
              className="absolute left-0 min-w-full px-3 whitespace-pre text-foreground/90"
              style={{
                height: LINE_HEIGHT,
                lineHeight: `${LINE_HEIGHT}px`,
                transform: `translateY(${item.start}px)`,
              }}
            >
              {rows[item.index]}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusLabel({ status }: { status: Status }) {
  if (status.kind === "error") {
    return (
      <span className="truncate text-destructive" title={status.message}>
        {status.message}
      </span>
    );
  }
  const label = { connecting: "Connecting…", live: "Live", ended: "Ended" }[status.kind];
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span
        className={cn(
          "size-1.5 rounded-full",
          status.kind === "live" ? "bg-success" : "bg-muted-foreground/60",
          status.kind === "connecting" && "animate-pulse motion-reduce:animate-none",
        )}
      />
      {label}
    </span>
  );
}
