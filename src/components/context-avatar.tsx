import type { KubeContext } from "@/lib/kube";
import { contextLabel } from "@/lib/kube";
import { cn } from "@/lib/utils";

/** Hues offered in Settings; also the pool the automatic color is drawn from. */
export const AVATAR_HUES = [276, 220, 190, 155, 80, 50, 25, 330];

/** Stable hue per context name, so a rename keeps the color. */
export function autoHue(name: string) {
  const hash = [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return AVATAR_HUES[hash % AVATAR_HUES.length];
}

export const avatarBackground = (hue: number) => `oklch(0.55 0.13 ${hue})`;

export function ContextAvatar({
  context,
  className,
}: {
  context: KubeContext;
  className?: string;
}) {
  const hue = context.hue ?? autoHue(context.name);
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white",
        className,
      )}
      style={{ background: avatarBackground(hue) }}
    >
      {contextLabel(context).slice(0, 1).toUpperCase()}
    </span>
  );
}
