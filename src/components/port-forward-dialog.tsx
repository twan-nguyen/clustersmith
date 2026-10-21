import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, Check, Copy, ExternalLink } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type ObjectRef,
  type PortChoice,
  type PortForward,
  forwardUrl,
  listForwardPorts,
  startPortForward,
} from "@/lib/kube";
import { cn, errorMessage } from "@/lib/utils";

const INPUT =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 tabular-nums outline-none focus:border-ring";

/** A port number typed by hand, or `null` when it is not one. */
function parsePort(value: string) {
  const port = Number(value);
  return value !== "" && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * Starts a port forward to a pod or service. Ports the object declares are
 * offered as chips; any other port can be typed. Once running, the dialog
 * shows the local address, since an automatic port is only known then.
 */
export function PortForwardDialog({
  open,
  onClose,
  object,
}: {
  open: boolean;
  onClose: () => void;
  object: ObjectRef;
}) {
  const [choices, setChoices] = useState<PortChoice[] | null>(null);
  const [port, setPort] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [openBrowser, setOpenBrowser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<PortForward | null>(null);
  const ids = { port: useId(), local: useId(), browser: useId() };

  function reset() {
    setChoices(null);
    setPort("");
    setLocalPort("");
    setError(null);
    setStarted(null);
    listForwardPorts(object)
      .then((choices) => {
        setChoices(choices);
        if (choices.length > 0) setPort(String(choices[0].port));
      })
      .catch((err) => {
        setChoices([]);
        setError(errorMessage(err));
      });
  }

  const remote = parsePort(port);
  const local = localPort === "" ? null : parsePort(localPort);
  const valid = remote !== null && (localPort === "" || local !== null);

  async function start() {
    if (remote === null) return;
    setBusy(true);
    setError(null);
    try {
      const forward = await startPortForward(object, remote, local);
      if (openBrowser) {
        await openUrl(forwardUrl(forward));
        onClose();
      } else {
        setStarted(forward);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) reset();
        else onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        {started ? (
          <Started forward={started} onDone={onClose} />
        ) : (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && !busy) start();
            }}
          >
            <DialogHeader>
              <DialogTitle className="break-all">Port forward "{object.name}"</DialogTitle>
              <DialogDescription>
                {object.resource === "services"
                  ? "Connections go to a ready pod behind the service."
                  : "Connections go straight to this pod."}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2">
              <label htmlFor={ids.port} className="text-muted-foreground">
                {object.resource === "services" ? "Service port" : "Pod port"}
              </label>
              {choices === null ? (
                <div className="h-7 animate-pulse rounded-md bg-muted-foreground/10" />
              ) : (
                choices.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {choices.map((c) => (
                      <button
                        key={c.port}
                        type="button"
                        onClick={() => setPort(String(c.port))}
                        className={cn(
                          "flex h-7 items-center gap-1.5 rounded-md border border-border px-2 tabular-nums transition-colors duration-100 hover:bg-accent",
                          remote === c.port && "border-ring bg-accent",
                        )}
                      >
                        {c.port}
                        {c.name && <span className="text-muted-foreground">{c.name}</span>}
                      </button>
                    ))}
                  </div>
                )
              )}
              <input
                id={ids.port}
                type="number"
                min={1}
                max={65535}
                autoFocus
                placeholder="Port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className={INPUT}
              />
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor={ids.local} className="text-muted-foreground">
                Local port
              </label>
              <input
                id={ids.local}
                type="number"
                min={1}
                max={65535}
                placeholder="Any free port"
                value={localPort}
                onChange={(e) => setLocalPort(e.target.value)}
                className={INPUT}
              />
            </div>

            <label htmlFor={ids.browser} className="flex items-center gap-2">
              <input
                id={ids.browser}
                type="checkbox"
                checked={openBrowser}
                onChange={(e) => setOpenBrowser(e.target.checked)}
                className="size-3.5 accent-primary"
              />
              Open in browser
            </label>

            {error && <p className="animate-fade-in break-words text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !valid}>
                Start
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Started({ forward, onDone }: { forward: PortForward; onDone: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Forwarding</DialogTitle>
        <DialogDescription className="break-all">
          It keeps running until you stop it under Port Forwards.
        </DialogDescription>
      </DialogHeader>
      <div className="flex animate-fade-in items-center gap-2 rounded-md border border-border px-3 py-2 tabular-nums">
        <span className="font-medium">localhost:{forward.localPort}</span>
        <ArrowRight className="size-3.5 text-muted-foreground" />
        <span className="truncate text-muted-foreground">
          {forward.name}:{forward.port}
        </span>
      </div>
      <DialogFooter>
        <CopyButton text={forwardUrl(forward)} />
        <Button variant="outline" onClick={() => openUrl(forwardUrl(forward))}>
          <ExternalLink />
          Open
        </Button>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}

export function CopyButton({ text, compact }: { text: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <Button
      variant={compact ? "ghost" : "outline"}
      size={compact ? "icon-xs" : "default"}
      onClick={copy}
      title="Copy address"
      aria-label="Copy address"
    >
      {copied ? <Check /> : <Copy />}
      {!compact && (copied ? "Copied" : "Copy")}
    </Button>
  );
}
