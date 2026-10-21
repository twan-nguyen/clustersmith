import {
  Ban,
  Cable,
  CircleCheck,
  Ellipsis,
  FileCode,
  History,
  LogOut,
  RotateCw,
  Scaling,
  ScrollText,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";

import { PortForwardDialog } from "@/components/port-forward-dialog";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type DrainReport,
  type ObjectRef,
  type ResourceKind,
  cordonNode,
  deleteResource,
  drainNode,
  forwardable,
  hasPods,
  restartWorkload,
  scaleWorkload,
} from "@/lib/kube";
import { errorMessage } from "@/lib/utils";
import { useStore } from "@/store";

type Pending = "delete" | "restart" | "scale" | "forward" | "cordon" | "drain" | null;

/**
 * The "⋯" menu on a row. Anything that changes the cluster asks first; the
 * live list then shows the result, so nothing here updates rows by hand.
 */
export function ObjectMenu({
  object,
  kind,
  replicas,
  containers,
  cordoned,
}: {
  object: ObjectRef;
  kind: ResourceKind | undefined;
  /** Current desired replicas, to prefill the scale dialog. */
  replicas?: number;
  /** A pod's containers, to pick whose previous logs to read. */
  containers?: string[];
  /** For nodes: whether new pods are kept off it. */
  cordoned?: boolean;
}) {
  const openTab = useStore((s) => s.openTab);
  const [pending, setPending] = useState<Pending>(null);
  const singular = kind?.singular ?? object.resource;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={`Actions for ${object.name}`}
            title="Actions"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-foreground/10 hover:text-foreground data-[state=open]:bg-foreground/10 [&_svg]:size-3.5"
          >
            <Ellipsis />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => openTab({ kind: "yaml", ...object })}>
            <FileCode />
            Edit YAML
          </DropdownMenuItem>
          {hasPods(object.resource) && object.namespace && (
            <DropdownMenuItem onSelect={() => openTab({ kind: "workload-logs", ...object })}>
              <ScrollText />
              Logs of all pods
            </DropdownMenuItem>
          )}
          {object.resource === "pods" && object.namespace && (
            <PreviousLogs
              containers={containers ?? []}
              onOpen={(container) =>
                openTab({
                  kind: "logs",
                  context: object.context,
                  namespace: object.namespace!,
                  pod: object.name,
                  container,
                  previous: true,
                })
              }
            />
          )}
          {object.resource === "nodes" && (
            <>
              <DropdownMenuItem onSelect={() => setPending("cordon")}>
                {cordoned ? <CircleCheck /> : <Ban />}
                {cordoned ? "Uncordon" : "Cordon"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPending("drain")}>
                <LogOut />
                Drain…
              </DropdownMenuItem>
            </>
          )}
          {forwardable(object.resource) && (
            <DropdownMenuItem onSelect={() => setPending("forward")}>
              <Cable />
              Port forward…
            </DropdownMenuItem>
          )}
          {kind?.restartable && (
            <DropdownMenuItem onSelect={() => setPending("restart")}>
              <RotateCw />
              Restart
            </DropdownMenuItem>
          )}
          {kind?.scalable && (
            <DropdownMenuItem onSelect={() => setPending("scale")}>
              <Scaling />
              Scale…
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setPending("delete")}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={pending === "delete"}
        onClose={() => setPending(null)}
        title={`Delete ${singular} "${object.name}"?`}
        description={
          object.resource === "pods"
            ? "A pod owned by a controller is replaced by a new one."
            : "This cannot be undone."
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleteResource(object)}
      />
      <ConfirmDialog
        open={pending === "restart"}
        onClose={() => setPending(null)}
        title={`Restart ${singular} "${object.name}"?`}
        description="Pods are replaced one by one, like kubectl rollout restart."
        confirmLabel="Restart"
        onConfirm={() => restartWorkload(object)}
      />
      <ConfirmDialog
        open={pending === "cordon"}
        onClose={() => setPending(null)}
        title={`${cordoned ? "Uncordon" : "Cordon"} node "${object.name}"?`}
        description={
          cordoned
            ? "New pods can be scheduled on it again."
            : "No new pods are scheduled on it; pods already there keep running."
        }
        confirmLabel={cordoned ? "Uncordon" : "Cordon"}
        onConfirm={() => cordonNode(object.context, object.name, !cordoned)}
      />
      <DrainDialog
        open={pending === "drain"}
        onClose={() => setPending(null)}
        context={object.context}
        node={object.name}
      />
      <PortForwardDialog
        open={pending === "forward"}
        onClose={() => setPending(null)}
        object={object}
      />
      <ScaleDialog
        open={pending === "scale"}
        onClose={() => setPending(null)}
        name={object.name}
        initial={replicas ?? 1}
        onScale={(n) => scaleWorkload(object, n)}
      />
    </>
  );
}

/** The previous run's logs; asks which container when there are several. */
function PreviousLogs({
  containers,
  onOpen,
}: {
  containers: string[];
  onOpen: (container: string | null) => void;
}) {
  if (containers.length <= 1) {
    return (
      <DropdownMenuItem onSelect={() => onOpen(null)}>
        <History />
        Previous logs
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <History />
        Previous logs
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-48">
        {containers.map((name) => (
          <DropdownMenuItem key={name} onSelect={() => onOpen(name)}>
            <span className="truncate">{name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * Drains a node like `kubectl drain --ignore-daemonsets`. Pods no controller
 * would recreate stop it first and are listed, so deleting them is a choice.
 */
function DrainDialog({
  open,
  onClose,
  context,
  node,
}: {
  open: boolean;
  onClose: () => void;
  context: string;
  node: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<DrainReport | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setReport(null);
  }, [open]);

  async function drain(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      setReport(await drainNode(context, node, force));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Unmanaged pods without force means nothing was evicted yet.
  const blocked = report !== null && report.unmanaged.length > 0 && report.evicted.length === 0;
  const done = report !== null && !blocked;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="break-all">Drain node "{node}"?</DialogTitle>
          <DialogDescription>
            The node is cordoned, then its pods are evicted so their controllers start them
            elsewhere. DaemonSet pods stay. Disruption budgets are respected, which can take a
            minute.
          </DialogDescription>
        </DialogHeader>

        {busy && (
          <p className="flex animate-fade-in items-center gap-2 text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-warning motion-reduce:animate-none" />
            Draining…
          </p>
        )}
        {blocked && (
          <div className="animate-fade-in">
            <p className="text-warning">
              {report.unmanaged.length} pod{report.unmanaged.length > 1 ? "s are" : " is"} not
              managed by a controller and would be gone for good:
            </p>
            <PodList pods={report.unmanaged} />
          </div>
        )}
        {done && (
          <div className="flex animate-fade-in flex-col gap-1">
            <p>
              Evicted {report.evicted.length} pod{report.evicted.length === 1 ? "" : "s"}
              {report.skipped.length > 0 && `, left ${report.skipped.length} DaemonSet or static`}.
            </p>
            {report.failed.length > 0 && (
              <>
                <p className="text-destructive">Could not evict {report.failed.length}:</p>
                <PodList pods={report.failed.map((f) => `${f.pod}: ${f.error}`)} />
              </>
            )}
          </div>
        )}
        {error && <p className="animate-fade-in break-words text-destructive">{error}</p>}

        <DialogFooter>
          {done ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              {blocked ? (
                <Button variant="destructive" disabled={busy} onClick={() => drain(true)}>
                  Delete them and drain
                </Button>
              ) : (
                <Button variant="destructive" disabled={busy} onClick={() => drain(false)}>
                  Drain
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PodList({ pods }: { pods: string[] }) {
  return (
    <ul className="mt-1 max-h-40 overflow-auto rounded-md border border-border px-3 py-2 font-mono text-xs">
      {pods.map((pod) => (
        <li key={pod} className="break-all">
          {pod}
        </li>
      ))}
    </ul>
  );
}

/** Runs `action` on confirm, keeping the dialog open with the error if it fails. */
function useAction(onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const close = () => {
    setError(null);
    onClose();
  };
  return { busy, error, run, close };
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
}) {
  const { busy, error, run, close } = useAction(onClose);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="break-all">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && <p className="animate-fade-in break-words text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={() => run(onConfirm)}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScaleDialog({
  open,
  onClose,
  name,
  initial,
  onScale,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  initial: number;
  onScale: (replicas: number) => Promise<void>;
}) {
  const { busy, error, run, close } = useAction(onClose);
  const [value, setValue] = useState(String(initial));
  const inputId = useId();
  const replicas = Number(value);

  // Radix does not call `onOpenChange` when `open` changes from outside.
  useEffect(() => {
    if (open) setValue(String(initial));
    // Only on opening: later list updates must not overwrite what is typed.
  }, [open]);
  const valid = value !== "" && Number.isInteger(replicas) && replicas >= 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
    >
      <DialogContent className="sm:max-w-sm">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) run(() => onScale(replicas));
          }}
        >
          <DialogHeader>
            <DialogTitle className="break-all">Scale "{name}"</DialogTitle>
            <DialogDescription>How many replicas should run.</DialogDescription>
          </DialogHeader>
          <label htmlFor={inputId} className="sr-only">
            Replicas
          </label>
          <input
            id={inputId}
            type="number"
            min={0}
            step={1}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-3 tabular-nums outline-none focus:border-ring"
          />
          {error && <p className="animate-fade-in break-words text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !valid}>
              Scale
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
