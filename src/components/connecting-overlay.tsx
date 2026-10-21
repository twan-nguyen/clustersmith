import { RotateCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { ContextAvatar, autoHue } from "@/components/context-avatar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { contextLabel } from "@/lib/kube";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

/** After this long, a hint about the usual culprit (VPN) appears. */
const SLOW_AFTER_S = 5;

/**
 * Covers the app from picking a cluster until it first answers, with a way
 * out: an unreachable API can take half a minute to time out. When it cannot
 * be reached, the same card offers a retry. It takes the cluster's color, so
 * it is clear at a glance which one is meant.
 */
export function ConnectingOverlay() {
  const connecting = useStore((s) => s.connecting);
  const failure = useStore((s) => s.connectError);
  const context = useStore((s) => s.contexts.find((c) => c.name === s.context));
  const disconnect = useStore((s) => s.disconnect);
  const reconnect = useStore((s) => s.reconnect);
  const [seconds, setSeconds] = useState(0);
  const open = connecting || failure !== null;

  useEffect(() => {
    if (!connecting) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [connecting, context?.name]);

  // Esc backs out to the cluster picker. Enter retries through the focused button.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && disconnect();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, disconnect]);

  if (!open || !context) return null;
  const label = contextLabel(context);
  const hue = context.hue ?? autoHue(context.name);
  const accent = failure !== null ? "var(--color-destructive)" : `oklch(0.78 0.14 ${hue})`;
  const slow = seconds >= SLOW_AFTER_S;

  return (
    <div
      data-tauri-drag-region
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/45 backdrop-blur-[3px]"
    >
      <div
        role="dialog"
        aria-modal
        aria-label={failure !== null ? `Can't reach ${label}` : `Connecting to ${label}`}
        className="relative w-[340px] animate-view-in overflow-hidden rounded-2xl border border-border bg-popover shadow-[0_24px_64px_-12px_oklch(0_0_0/60%)]"
      >
        {/* A wash of the cluster's color from the top edge. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-40"
          style={{
            background:
              failure !== null
                ? "radial-gradient(120% 100% at 50% 0%, color-mix(in oklch, var(--color-destructive) 16%, transparent), transparent 70%)"
                : `radial-gradient(120% 100% at 50% 0%, oklch(0.6 0.14 ${hue} / 18%), transparent 70%)`,
          }}
        />

        <div className="relative flex flex-col items-center px-6 pt-8 pb-6 text-center">
          <div className="relative">
            <div
              aria-hidden
              className="absolute inset-0 scale-125 rounded-2xl opacity-40 blur-xl"
              style={{ background: accent }}
            />
            {/* A light running around the avatar's edge; a still red one on failure. */}
            <div
              className={cn(
                "relative rounded-[18px] p-[2px]",
                failure === null && "animate-orbit motion-reduce:animate-none",
              )}
              style={{
                background:
                  failure !== null
                    ? accent
                    : `conic-gradient(from var(--orbit-angle), transparent 0deg 200deg, ${accent} 360deg)`,
              }}
            >
              <div className="rounded-2xl bg-popover p-[3px]">
                <ContextAvatar context={context} className="size-12 rounded-[13px] text-xl" />
              </div>
            </div>
            {failure !== null && (
              <span className="absolute -right-2 -bottom-2 flex size-6 animate-fade-in items-center justify-center rounded-full border-2 border-popover bg-destructive text-white">
                <TriangleAlert className="size-3" />
              </span>
            )}
          </div>

          <h2 className="mt-5 text-[15px] font-medium tracking-tight">
            {failure !== null ? `Can't reach ${label}` : `Connecting to ${label}`}
          </h2>
          <p
            className="mt-1.5 max-w-full truncate rounded-md bg-muted/60 px-2 py-0.5 font-mono text-xs text-muted-foreground"
            title={context.name}
          >
            {context.name}
          </p>
          {failure !== null && (
            <p
              className="mt-4 line-clamp-3 animate-fade-in text-xs break-words text-muted-foreground"
              title={failure}
            >
              {failure}
            </p>
          )}
        </div>

        {failure !== null ? (
          <div className="flex items-center gap-2 border-t border-border py-2 pr-2 pl-4">
            <span className="flex-1 truncate text-xs text-muted-foreground">Is the VPN on?</span>
            <Button variant="ghost" size="sm" onClick={disconnect}>
              Other cluster
            </Button>
            <Button size="sm" onClick={reconnect} autoFocus className="gap-1.5">
              <RotateCw />
              Retry
            </Button>
          </div>
        ) : (
          <>
            {/* An indeterminate bar doubles as the divider above the footer. */}
            <div aria-hidden className="relative h-px overflow-hidden bg-border">
              <div
                className="absolute inset-y-0 w-1/3 animate-indeterminate motion-reduce:hidden"
                style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
              />
            </div>
            <div className="flex h-11 items-center gap-3 pr-2 pl-4">
              <span
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 text-xs",
                  slow ? "text-warning" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none",
                    slow ? "bg-warning" : "bg-muted-foreground/70",
                  )}
                />
                <span key={slow ? "slow" : "loading"} className="animate-fade-in truncate">
                  {slow ? "No answer yet. Is the VPN on?" : "Reaching the API server…"}
                </span>
                <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                  {seconds}s
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={disconnect} className="gap-1.5">
                Cancel
                <Kbd>Esc</Kbd>
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
