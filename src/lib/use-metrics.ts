import { useEffect, useState } from "react";

import { type Usage, getMetrics } from "@/lib/kube";
import { useStore } from "@/store";

/** metrics-server samples about every 15 seconds; asking more often adds nothing. */
const POLL_MS = 15_000;

/**
 * Live usage for the pods or nodes on screen, or `null` while loading and
 * on clusters without metrics-server, where the columns stay hidden.
 */
export function useMetrics(kind: "pods" | "nodes", enabled = true) {
  const context = useStore((s) => s.context);
  const namespace = useStore((s) => (kind === "pods" ? s.namespace : null));
  const [metrics, setMetrics] = useState<Record<string, Usage> | null>(null);

  useEffect(() => {
    setMetrics(null);
    if (!context || !enabled) return;
    let cancelled = false;
    const load = () =>
      getMetrics(context, kind, namespace)
        .then((m) => !cancelled && setMetrics(m))
        // A failed sample keeps the last one; the next poll tries again.
        .catch(() => {});
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [context, kind, namespace, enabled]);

  return metrics;
}
