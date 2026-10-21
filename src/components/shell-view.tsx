import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import { closeSession, openShell, shellInput, shellResize } from "@/lib/kube";
import { errorMessage } from "@/lib/utils";
import type { PodTab } from "@/store";

/** The panel's colors in hex, since xterm does not read OKLCH. */
const THEME = {
  background: "#121214",
  foreground: "#e7e7ea",
  cursor: "#a4a8ff",
  cursorAccent: "#121214",
  selectionBackground: "#6975d855",
};

/** Fitting a hidden terminal would shrink it to nothing. */
function fitIfVisible(fit: FitAddon, el: HTMLElement | null) {
  if (el && el.offsetWidth > 0 && el.offsetHeight > 0) fit.fit();
}

export function ShellView({ tab, active }: { tab: PodTab; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<{ term: Terminal; fit: FitAddon } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fitIfVisible(fit, el);
    terminal.current = { term, fit };

    let id: number | null = null;
    let cancelled = false;
    openShell(tab, { cols: term.cols, rows: term.rows }, (event) => {
      if (cancelled) return;
      if (event.type === "output") term.write(event.data);
      else if (event.type === "exited") term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
      else term.write(`\r\n\x1b[31m${event.message}\x1b[0m\r\n`);
    })
      .then((sessionId) => {
        // The tab may have closed while the shell was connecting.
        if (cancelled) return closeSession(sessionId);
        id = sessionId;
      })
      .catch((err) => !cancelled && term.write(`\x1b[31m${errorMessage(err)}\x1b[0m\r\n`));

    const input = term.onData((data) => id !== null && shellInput(id, data));
    const resize = term.onResize(({ cols, rows }) => id !== null && shellResize(id, cols, rows));
    const observer = new ResizeObserver(() => fitIfVisible(fit, el));
    observer.observe(el);

    return () => {
      cancelled = true;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      if (id !== null) closeSession(id);
      term.dispose();
      terminal.current = null;
    };
  }, [tab]);

  // Coming back to the tab: take the keyboard and match the current size.
  useEffect(() => {
    if (!active || !terminal.current) return;
    fitIfVisible(terminal.current.fit, host.current);
    terminal.current.term.focus();
  }, [active]);

  return (
    <div className="h-full w-full py-2 pl-3">
      <div ref={host} className="h-full w-full" />
    </div>
  );
}
