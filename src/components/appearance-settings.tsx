import { useId, useState } from "react";

import { SettingsHeading } from "@/components/settings-heading";
import { Slider } from "@/components/ui/slider";
import { errorMessage } from "@/lib/utils";
import { useStore } from "@/store";

export function AppearanceSettings() {
  const { transparency, previewTransparency, setTransparency } = useStore();
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();

  // Both paths reach the native window, so both can fail the same way.
  const run = (action: Promise<void>) => {
    setError(null);
    action.catch((err) => setError(errorMessage(err)));
  };

  return (
    <>
      <SettingsHeading title="Appearance" description="How the ClusterSmith window looks." />

      <div className="flex flex-col gap-4 rounded-lg border border-border px-4 py-4">
        <div className="flex items-start justify-between gap-6">
          <div className="flex flex-col gap-1">
            <span id={labelId} className="font-medium">
              Transparency
            </span>
            <span className="text-muted-foreground">
              Blur what is behind the window into the sidebar and around the panels, like
              Finder. The content panels stay solid so tables remain easy to read.
            </span>
          </div>
          <span className="w-10 shrink-0 text-right font-medium tabular-nums">
            {transparency === 0 ? "Off" : `${transparency}%`}
          </span>
        </div>

        <Slider
          aria-labelledby={labelId}
          min={0}
          max={100}
          step={5}
          value={[transparency]}
          // Follow the pointer live; write the settings file once, on release.
          onValueChange={([value]) => run(previewTransparency(value))}
          onValueCommit={([value]) => run(setTransparency(value))}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Solid</span>
          <span>Clear</span>
        </div>
      </div>

      {error && <p className="animate-fade-in text-destructive">{error}</p>}
    </>
  );
}
