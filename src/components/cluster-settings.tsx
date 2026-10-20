import { Check, RotateCcw } from "lucide-react";
import { useState } from "react";

import {
  AVATAR_HUES,
  ContextAvatar,
  autoHue,
  avatarBackground,
} from "@/components/context-avatar";
import { SettingsHeading } from "@/components/settings-heading";
import { Button } from "@/components/ui/button";
import type { ClusterPrefs, KubeContext } from "@/lib/kube";
import { cn, errorMessage } from "@/lib/utils";
import { useStore } from "@/store";

export function ClusterSettings() {
  const { contexts, updateCluster, setSettingsPage } = useStore();
  const [error, setError] = useState<string | null>(null);

  async function save(context: KubeContext, prefs: Partial<ClusterPrefs>) {
    setError(null);
    try {
      await updateCluster(context.name, {
        displayName: context.displayName,
        hue: context.hue,
        ...prefs,
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <SettingsHeading
        title="Clusters"
        description="Give clusters a name and color that are easy to tell apart. Only ClusterSmith shows them; your kubeconfig files are not changed."
      />

      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {contexts.length === 0 ? (
          <div className="px-4 py-10 text-center text-muted-foreground">
            No clusters yet.{" "}
            <button
              onClick={() => setSettingsPage("kubeconfig")}
              className="text-foreground underline-offset-4 hover:underline"
            >
              Add a kubeconfig file
            </button>{" "}
            to see them here.
          </div>
        ) : (
          contexts.map((context) => (
            <ClusterRow key={context.name} context={context} onSave={save} />
          ))
        )}
      </div>

      {error && <p className="animate-fade-in text-destructive">{error}</p>}
    </>
  );
}

function ClusterRow({
  context,
  onSave,
}: {
  context: KubeContext;
  onSave: (context: KubeContext, prefs: Partial<ClusterPrefs>) => void;
}) {
  const customized = context.displayName !== null || context.hue !== null;

  function commitName(input: HTMLInputElement) {
    const value = input.value.trim();
    if (value === (context.displayName ?? "")) return;
    onSave(context, { displayName: value || null });
  }

  return (
    <div className="flex animate-fade-in items-start gap-4 px-4 py-4">
      <ContextAvatar context={context} className="mt-0.5 size-8 rounded-lg text-sm" />

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <input
            // Remount after a save so the field shows what was stored.
            key={context.displayName ?? ""}
            defaultValue={context.displayName ?? ""}
            placeholder={context.name}
            aria-label={`Display name for ${context.name}`}
            onBlur={(e) => commitName(e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = context.displayName ?? "";
                e.currentTarget.blur();
              }
            }}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 font-medium transition-colors duration-100 outline-none placeholder:font-normal placeholder:text-muted-foreground hover:border-ring/40 focus:border-ring"
          />
          <div className="truncate px-0.5 text-xs text-muted-foreground" title={context.name}>
            {context.name} · {context.cluster}
          </div>
        </div>

        <HuePicker
          name={context.name}
          value={context.hue}
          onChange={(hue) => onSave(context, { hue })}
        />
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        title="Reset to kubeconfig name and automatic color"
        aria-label={`Reset ${context.name}`}
        disabled={!customized}
        onClick={() => onSave(context, { displayName: null, hue: null })}
        className="mt-0.5"
      >
        <RotateCcw />
      </Button>
    </div>
  );
}

const HUE_NAMES: Record<number, string> = {
  276: "Indigo",
  220: "Blue",
  190: "Teal",
  155: "Green",
  80: "Yellow",
  50: "Orange",
  25: "Red",
  330: "Pink",
};

/** "Auto" keeps the color derived from the context name. */
function HuePicker({
  name,
  value,
  onChange,
}: {
  name: string;
  value: number | null;
  onChange: (hue: number | null) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex items-center gap-1.5">
      <Swatch
        label="Automatic"
        selected={value === null}
        background={avatarBackground(autoHue(name))}
        onClick={() => onChange(null)}
      >
        <span className="text-[9px] font-semibold text-white">A</span>
      </Swatch>
      <span className="mx-1 h-4 w-px bg-border" />
      {AVATAR_HUES.map((hue) => (
        <Swatch
          key={hue}
          label={HUE_NAMES[hue] ?? `Hue ${hue}`}
          selected={value === hue}
          background={avatarBackground(hue)}
          onClick={() => onChange(hue)}
        />
      ))}
    </div>
  );
}

function Swatch({
  label,
  selected,
  background,
  onClick,
  children,
}: {
  label: string;
  selected: boolean;
  background: string;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-5 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-[box-shadow,transform] duration-150 ease-out-quart hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-foreground/70",
      )}
      style={{ background }}
    >
      {selected && !children ? <Check className="size-3 text-white" /> : children}
    </button>
  );
}
