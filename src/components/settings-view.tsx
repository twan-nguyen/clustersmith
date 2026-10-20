import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { FileText, Plus, Settings, X } from "lucide-react";
import { useState } from "react";

import { Panel, PanelHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import type { KubeconfigSource } from "@/lib/kube";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function SettingsView() {
  const { sources, addKubeconfig, removeKubeconfig } = useStore();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pickFiles() {
    setError(null);
    // Kubeconfig files usually have no extension, so no filter; start in ~/.kube.
    const picked = await open({
      multiple: true,
      directory: false,
      defaultPath: await join(await homeDir(), ".kube"),
      title: "Add kubeconfig files",
    });
    if (!picked) return;

    setBusy(true);
    try {
      for (const path of picked) await addKubeconfig(path);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(path: string) {
    setError(null);
    try {
      await removeKubeconfig(path);
    } catch (err) {
      setError(message(err));
    }
  }

  return (
    <Panel>
      <PanelHeader>
        <Settings className="size-4 text-muted-foreground" />
        <span className="text-muted-foreground">Settings</span>
        <span className="text-muted-foreground/60">/</span>
        <h1 className="font-medium">Kubeconfig files</h1>
      </PanelHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-12">
          <div className="flex items-end justify-between gap-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="text-xl font-semibold">Kubeconfig files</h2>
              <p className="text-muted-foreground">
                ClusterSmith reads clusters from these files. Added files are linked by path,
                not copied; edits to them are picked up on the next launch.
              </p>
            </div>
            <Button onClick={pickFiles} disabled={busy} className="shrink-0">
              <Plus />
              Add files…
            </Button>
          </div>

          <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {sources.length === 0 ? (
              <div className="px-4 py-10 text-center text-muted-foreground">
                No kubeconfig files yet. Add one to see its clusters.
              </div>
            ) : (
              sources.map((source) => (
                <SourceRow key={source.path} source={source} onRemove={remove} />
              ))
            )}
          </div>

          {error && <p className="text-destructive">{error}</p>}

          <p className="text-xs text-muted-foreground">
            ~/.kube/config and files in $KUBECONFIG are always read and marked as default.
            Press ⌘⇧. in the file picker to show hidden folders.
          </p>
        </section>
      </div>
    </Panel>
  );
}

function SourceRow({
  source,
  onRemove,
}: {
  source: KubeconfigSource;
  onRemove: (path: string) => void;
}) {
  const contexts = `${source.contexts} ${source.contexts === 1 ? "cluster" : "clusters"}`;
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate" title={source.path}>
          {source.path}
        </div>
        <div className={cn("text-xs", source.error ? "text-destructive" : "text-muted-foreground")}>
          {source.error ?? (source.imported ? contexts : `${contexts} · default`)}
        </div>
      </div>
      {source.imported && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${source.path}`}
          title="Remove"
          onClick={() => onRemove(source.path)}
        >
          <X />
        </Button>
      )}
    </div>
  );
}
