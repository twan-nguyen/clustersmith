import { useVirtualizer } from "@tanstack/react-virtual";
import { save } from "@tauri-apps/plugin-dialog";
import { ArrowDownToLine, Download, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { autoHue } from "@/components/context-avatar";
import {
  type LogEvent,
  closeSession,
  openLogs,
  openWorkloadLogs,
  saveLog,
} from "@/lib/kube";
import { cn, errorMessage } from "@/lib/utils";
import type { PodTab, WorkloadLogsTab } from "@/store";

/** Oldest lines are dropped past this, so a long session stays light. */
const MAX_LINES = 20_000;
const LINE_HEIGHT = 18;

// Color and cursor escape codes; logs are shown as plain text.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

type Line = { text: string; source?: string };

type Status =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "reconnecting" }
  | { kind: "ended" }
  | { kind: "error"; message: string };

type LogsTab = PodTab | WorkloadLogsTab;

function open(tab: LogsTab, onEvent: (event: LogEvent) => void) {
  return tab.kind === "workload-logs" ? openWorkloadLogs(tab, onEvent) : openLogs(tab, onEvent);
}

/** A file name for the download, like `web-7f9c.log` or `web-7f9c-previous.log`. */
function fileName(tab: LogsTab) {
  if (tab.kind === "workload-logs") return `${tab.name}.log`;
  const parts = [tab.pod, tab.container, tab.previous && "previous"].filter(Boolean);
  return `${parts.join("-")}.log`;
}

export function LogsView({ tab, active }: { tab: LogsTab; active: boolean }) {
  const lines = useRef<Line[]>([]);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const filterInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let id: number | null = null;
    let cancelled = false;
    open(tab, (event) => {
      if (cancelled) return;
      if (event.type === "lines") {
        const buffer = lines.current;
        for (const line of event.lines) {
          buffer.push({ text: line.replace(ANSI, ""), source: event.source });
        }
        if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
        setVersion((v) => v + 1);
      } else {
        setStatus({ kind: event.type });
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

  const needle = filter.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!needle) return lines.current;
    return lines.current.filter(
      (l) => l.text.toLowerCase().includes(needle) || l.source?.toLowerCase().includes(needle),
    );
    // `version` bumps whenever the shared buffer grows.
  }, [needle, version]);

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

  // ⌘F jumps to the filter while this tab is on screen.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "f" && e.metaKey) {
        e.preventDefault();
        filterInput.current?.focus();
        filterInput.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  // Scrolling up to read pauses following; scrolling back to the end resumes it.
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < LINE_HEIGHT * 2;
    if (atEnd !== follow) setFollow(atEnd);
  }

  // Saves what is shown: with a filter, only the matching lines.
  async function download() {
    const path = await save({ defaultPath: fileName(tab) });
    if (!path) return;
    const text = rows.map((l) => (l.source ? `[${l.source}] ${l.text}` : l.text)).join("\n");
    try {
      await saveLog(path, `${text}\n`);
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-xs">
        <label className="flex h-6 w-56 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground transition-colors duration-100 hover:bg-accent focus-within:bg-accent">
          <Search className="size-3.5" />
          <input
            ref={filterInput}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              setFilter("");
              e.currentTarget.blur();
            }}
            placeholder="Filter lines  ⌘F"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <span className="text-muted-foreground tabular-nums">
          {needle ? `${rows.length} of ${lines.current.length}` : lines.current.length} lines
        </span>
        {tab.kind === "logs" && tab.previous && (
          <span className="rounded bg-muted px-1.5 text-muted-foreground">Previous run</span>
        )}
        <StatusLabel status={status} />
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={download}
            disabled={rows.length === 0}
            title="Save the shown lines to a file"
            className="flex h-6 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <Download className="size-3.5" />
            Save
          </button>
          <button
            onClick={() => setFollow(!follow)}
            aria-pressed={follow}
            title="Follow new lines"
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground",
              follow && "text-foreground",
            )}
          >
            <ArrowDownToLine className="size-3.5" />
            Follow
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto font-mono text-xs select-text"
      >
        <div className="relative w-max min-w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const line = rows[item.index];
            return (
              <div
                key={item.index}
                className="absolute left-0 min-w-full px-3 whitespace-pre text-foreground/90"
                style={{
                  height: LINE_HEIGHT,
                  lineHeight: `${LINE_HEIGHT}px`,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {line.source && <SourceTag source={line.source} />}
                <Highlighted text={line.text} needle={needle} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The pod a line came from, colored per pod so interleaved lines stay apart. */
function SourceTag({ source }: { source: string }) {
  return (
    <span className="mr-2 select-none" style={{ color: `oklch(0.75 0.12 ${autoHue(source)})` }}>
      {source}
    </span>
  );
}

/** Marks every occurrence of the filter, so the reason a line matched shows. */
function Highlighted({ text, needle }: { text: string; needle: string }) {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="rounded-sm bg-warning/30 text-foreground">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}

function StatusLabel({ status }: { status: Status }) {
  if (status.kind === "error") {
    return (
      <span className="truncate text-destructive" title={status.message}>
        {status.message}
      </span>
    );
  }
  const label = {
    connecting: "Connecting…",
    live: "Live",
    reconnecting: "Reconnecting…",
    ended: "Ended",
  }[status.kind];
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span
        className={cn(
          "size-1.5 rounded-full",
          status.kind === "live" && "bg-success",
          status.kind === "reconnecting" && "bg-warning",
          (status.kind === "connecting" || status.kind === "ended") && "bg-muted-foreground/60",
          (status.kind === "connecting" || status.kind === "reconnecting") &&
            "animate-pulse motion-reduce:animate-none",
        )}
      />
      {label}
    </span>
  );
}
