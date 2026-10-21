import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, Cable, ExternalLink, Square } from "lucide-react";

import { ContextAvatar } from "@/components/context-avatar";
import { KindIcon } from "@/components/kind-icon";
import { StatusIcon } from "@/components/list-panel";
import { Panel, PanelHeader } from "@/components/panel";
import { CopyButton } from "@/components/port-forward-dialog";
import { Button } from "@/components/ui/button";
import { type PortForward, contextLabel, forwardUrl, stopPortForward } from "@/lib/kube";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

const GRID = {
  gridTemplateColumns: "minmax(200px,2fr) minmax(120px,1fr) 200px minmax(160px,1.5fr) 92px",
};

/** Every running port forward, across clusters, with ways to use or stop it. */
export function PortForwardsView() {
  const forwards = useStore((s) => s.forwards);

  return (
    <Panel>
      <PanelHeader>
        <Cable className="size-4 text-muted-foreground" />
        <h1 className="font-medium">Port Forwards</h1>
        <span className="text-muted-foreground tabular-nums">{forwards.length}</span>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {forwards.length === 0 ? (
          <div className="flex animate-fade-in flex-col items-center gap-1 px-8 py-24 text-center">
            <div className="font-medium">No port forwards</div>
            <div className="max-w-md text-muted-foreground">
              Start one from the ⋯ menu of a pod or service.
            </div>
          </div>
        ) : (
          <>
            <div
              className="sticky top-0 z-10 grid h-8 items-center gap-4 border-b border-border bg-card px-5 text-xs text-muted-foreground"
              style={GRID}
            >
              <span>Name</span>
              <span>Cluster</span>
              <span>Address</span>
              <span>Status</span>
              <span className="sr-only">Actions</span>
            </div>
            {forwards.map((f) => (
              <ForwardRow key={f.id} forward={f} />
            ))}
          </>
        )}
      </div>
    </Panel>
  );
}

function ForwardRow({ forward }: { forward: PortForward }) {
  const context = useStore((s) => s.contexts.find((c) => c.name === forward.context));

  return (
    <div
      className="group grid h-10 animate-fade-in items-center gap-4 border-b border-border/50 px-5 transition-colors duration-100 hover:bg-accent"
      style={GRID}
    >
      <span
        className="flex min-w-0 items-center gap-2"
        title={`${forward.namespace}/${forward.name}`}
      >
        <span className="text-muted-foreground [&_svg]:size-3.5">
          <KindIcon kind={forward.resource} />
        </span>
        <span className="truncate">{forward.name}</span>
        <span className="truncate text-muted-foreground">{forward.namespace}</span>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {context && <ContextAvatar context={context} />}
        <span className="truncate text-muted-foreground">
          {context ? contextLabel(context) : forward.context}
        </span>
      </span>
      <span className="flex items-center gap-1.5 tabular-nums">
        localhost:{forward.localPort}
        <ArrowRight className="size-3 text-muted-foreground" />
        <span className="text-muted-foreground">{forward.port}</span>
      </span>
      <span
        className="flex min-w-0 items-center gap-2"
        title={forward.error ?? forward.pod ?? undefined}
      >
        <StatusIcon tone={forward.error ? "failed" : "ok"} />
        <span className={cn("truncate", forward.error ? "text-destructive" : "text-muted-foreground")}>
          {forward.error ?? forward.pod}
        </span>
      </span>
      <span className="flex justify-end gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          title="Open in browser"
          aria-label="Open in browser"
          onClick={() => openUrl(forwardUrl(forward))}
        >
          <ExternalLink />
        </Button>
        <CopyButton text={forwardUrl(forward)} compact />
        <Button
          variant="ghost"
          size="icon-xs"
          title="Stop"
          aria-label="Stop"
          onClick={() => stopPortForward(forward.id)}
          className="hover:text-destructive"
        >
          <Square className="fill-current" />
        </Button>
      </span>
    </div>
  );
}
