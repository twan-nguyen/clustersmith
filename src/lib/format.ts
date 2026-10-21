import { useEffect, useState } from "react";

/** Compact age like `kubectl`: 42s, 5m, 3h, 12d. */
export function formatAge(createdAt: string | null, now: number) {
  if (!createdAt) return "—";
  const seconds = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Current time, refreshed on an interval so relative ages stay fresh. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export type StatusTone = "ok" | "done" | "pending" | "failed" | "unknown";

const TONES: Record<string, StatusTone> = {
  Running: "ok",
  Completed: "done",
  Succeeded: "done",
  Pending: "pending",
  ContainerCreating: "pending",
  PodInitializing: "pending",
  Terminating: "pending",
  Failed: "failed",
  Error: "failed",
  CrashLoopBackOff: "failed",
  ImagePullBackOff: "failed",
  ErrImagePull: "failed",
  OOMKilled: "failed",
  CreateContainerConfigError: "failed",
};

export const statusTone = (status: string): StatusTone =>
  TONES[status] ?? "unknown";

/** CPU cores as `kubectl top` prints them: `125m` under one core, else `1.25`. */
export function formatCpu(cores: number) {
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  return cores.toFixed(cores < 10 ? 2 : 1).replace(/\.?0+$/, "");
}

/** Bytes in binary units: `512Mi`, `1.5Gi`. */
export function formatBytes(bytes: number) {
  const units = ["", "Ki", "Mi", "Gi", "Ti"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value < 10 && unit > 0 ? 1 : 0;
  return `${value.toFixed(digits).replace(/\.0$/, "")}${units[unit]}`;
}
