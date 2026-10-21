import { Ellipsis, FileCode, RotateCw, Scaling, Trash2 } from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type ObjectRef,
  type ResourceKind,
  deleteResource,
  restartWorkload,
  scaleWorkload,
} from "@/lib/kube";
import { errorMessage } from "@/lib/utils";
import { useStore } from "@/store";

type Pending = "delete" | "restart" | "scale" | null;

/**
 * The "⋯" menu on a row. Anything that changes the cluster asks first; the
 * live list then shows the result, so nothing here updates rows by hand.
 */
export function ObjectMenu({
  object,
  kind,
  replicas,
}: {
  object: ObjectRef;
  kind: ResourceKind | undefined;
  /** Current desired replicas, to prefill the scale dialog. */
  replicas?: number;
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

function ConfirmDialog({
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
  const valid = value !== "" && Number.isInteger(replicas) && replicas >= 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setValue(String(initial));
        else close();
      }}
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
