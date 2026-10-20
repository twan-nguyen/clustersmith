import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { FileText, Plus, Settings, X } from "lucide-react";
import { useState } from "react";

import { ClusterSettings } from "@/components/cluster-settings";
import { Panel, PanelHeader } from "@/components/panel";
import { SettingsHeading } from "@/components/settings-heading";
import { Button } from "@/components/ui/button";
import type { KubeconfigSource } from "@/lib/kube";
import { cn, errorMessage as message } from "@/lib/utils";
import { type SettingsPage, useStore } from "@/store";

const TITLES: Record<SettingsPage, string> = {
  clusters: "Clusters",
  kubeconfig: "Kubeconfig files",
};

export function SettingsView() {
  const page = useStore((s) => s.settingsPage);

  return (
    <Panel>
      <PanelHeader>
        <Settings className="size-4 text-muted-foreground" />
        <span className="text-muted-foreground">Settings</span>
        <span className="text-muted-foreground/60">/</span>
        <h1 className="font-medium">{TITLES[page]}</h1>
      </PanelHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section
          key={page}
          className="mx-auto flex max-w-2xl animate-view-in flex-col gap-6 px-8 py-12"
        >
          {page === "clusters" ? <ClusterSettings /> : <KubeconfigSettings />}
        </section>
      </div>
    </Panel>
  );
}

function KubeconfigSettings() {
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
    <>
      <SettingsHeading
        title="Kubeconfig files"
        description="ClusterSmith reads clusters from these files. Added files are linked by path, not copied; edits to them are picked up on the next launch."
        action={
          <Button onClick={pickFiles} disabled={busy} className="shrink-0">
            <Plus />
            Add files…
          </Button>
        }
      />

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

      {error && <p className="animate-fade-in text-destructive">{error}</p>}

      <p className="text-xs text-muted-foreground">
        ~/.kube/config and files in $KUBECONFIG are always read and marked as default. Press
        ⌘⇧. in the file picker to show hidden folders.
      </p>
    </>
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
    <div className="flex animate-fade-in items-center gap-3 px-4 py-3">
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
