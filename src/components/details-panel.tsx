import { ArrowLeft, ChevronRight, Eye, EyeOff, FileCode, ScrollText, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { KindIcon } from "@/components/kind-icon";
import { StatusIcon } from "@/components/list-panel";
import { ObjectMenu } from "@/components/object-menu";
import { formatAge, statusTone, useNow } from "@/lib/format";
import { type Details, type KubeObject, type PodRow, describeResource } from "@/lib/kube";
import { cn, errorMessage } from "@/lib/utils";
import { type Selection, findKind, useStore } from "@/store";

/** Refreshes the events and pods even when the object itself is unchanged. */
const REFRESH_MS = 15_000;

/**
 * What `kubectl describe` shows, beside the list: properties, conditions,
 * containers, the pods behind a workload, and recent events. It reloads when
 * the object's row changes, so it stays as live as the list.
 */
export function DetailsPanel({ selection }: { selection: Selection }) {
  const select = useStore((s) => s.select);
  const openTab = useStore((s) => s.openTab);
  // Pods opened from a workload's pod list; Back returns to where it started.
  const [trail, setTrail] = useState<Selection[]>([]);
  const current = trail[trail.length - 1] ?? selection;
  const kind = useStore((s) => findKind(s, current.resource));
  const row = useStore((s) =>
    current.resource === "pods"
      ? s.pods.find((p) => p.uid === current.uid)
      : s.resources.find((r) => r.uid === current.uid),
  );
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(10_000);

  useEffect(() => setTrail([]), [selection]);

  // A fresh object starts empty; a changed one keeps showing the old details.
  const version = row ? JSON.stringify(row) : "";
  useEffect(() => {
    setDetails(null);
    setError(null);
  }, [current.uid, current.context]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      describeResource(current)
        .then((d) => {
          if (cancelled) return;
          setDetails(d);
          setError(null);
        })
        .catch((err) => !cancelled && setError(errorMessage(err)));
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `version` is the row as listed: a change there means the object changed.
  }, [current.uid, current.context, current.resource, current.namespace, current.name, version]);

  const openPod = (pod: PodRow) =>
    setTrail((t) => [
      ...t,
      {
        context: current.context,
        resource: "pods",
        namespace: pod.namespace,
        name: pod.name,
        uid: pod.uid,
      },
    ]);

  const object = details?.object;
  const replicas = object?.spec?.replicas;
  const containers: string[] =
    current.resource === "pods" ? (object?.spec?.containers ?? []).map((c: KubeObject) => c.name) : [];

  return (
    <aside className="flex w-[440px] shrink-0 animate-view-in flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_3px_oklch(0_0_0/30%)]">
      <header
        data-tauri-drag-region
        className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3"
      >
        {trail.length > 0 && (
          <IconButton label="Back" onClick={() => setTrail((t) => t.slice(0, -1))}>
            <ArrowLeft />
          </IconButton>
        )}
        <span className="text-muted-foreground [&_svg]:size-4">
          <KindIcon kind={current.resource} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate font-medium" title={current.name}>
            {current.name}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {[kind?.singular ?? current.resource, current.namespace].filter(Boolean).join(" · ")}
          </div>
        </div>
        <IconButton label="Edit YAML (e)" onClick={() => openTab({ kind: "yaml", ...current })}>
          <FileCode />
        </IconButton>
        <ObjectMenu
          object={current}
          kind={kind}
          replicas={typeof replicas === "number" ? replicas : undefined}
          containers={containers}
          cordoned={current.resource === "nodes" ? object?.spec?.unschedulable === true : undefined}
        />
        <IconButton label="Close (Esc)" onClick={() => select(null)}>
          <X />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {error && !details ? (
          <p className="py-8 text-center break-words text-destructive">{error}</p>
        ) : !details || !object ? (
          <DetailsSkeleton />
        ) : (
          <div key={current.uid} className="animate-fade-in">
            <Properties rows={properties(current.resource, object, now)} />
            <Conditions conditions={object.status?.conditions} now={now} />
            {current.resource === "pods" && (
              <PodContainers
                pod={object}
                onLogs={(container) =>
                  openTab({
                    kind: "logs",
                    context: current.context,
                    namespace: current.namespace!,
                    pod: current.name,
                    container,
                  })
                }
                onShell={(container) =>
                  openTab({
                    kind: "shell",
                    context: current.context,
                    namespace: current.namespace!,
                    pod: current.name,
                    container,
                  })
                }
              />
            )}
            <TemplateContainers object={object} />
            {details.pods && <Pods pods={details.pods} now={now} onOpen={openPod} />}
            <KindSections resource={current.resource} object={object} />
            <Labels title="Labels" labels={object.metadata?.labels} />
            <Annotations annotations={object.metadata?.annotations} />
            <Events events={details.events} now={now} />
          </div>
        )}
      </div>
    </aside>
  );
}

// Layout pieces.

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-foreground/10 hover:text-foreground [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5">
      <h2 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {title}
        {count !== undefined && <span className="tabular-nums">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

type Property = [label: string, value: React.ReactNode];

function Properties({ rows }: { rows: Property[] }) {
  const shown = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
  return (
    <dl className="mt-3 grid grid-cols-[132px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      {shown.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="truncate text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailsSkeleton() {
  return (
    <div role="status" aria-label="Loading details" className="mt-4 flex animate-fade-in flex-col gap-2.5">
      {["60%", "45%", "70%", "40%", "55%", "65%"].map((width, i) => (
        <div key={i} className="grid grid-cols-[132px_1fr] gap-3">
          <span className="h-3 w-20 animate-pulse rounded bg-muted-foreground/10" />
          <span className="h-3 animate-pulse rounded bg-muted-foreground/15" style={{ width }} />
        </div>
      ))}
    </div>
  );
}

// Reading the object.

const mono = (text: React.ReactNode) => <span className="font-mono text-xs">{text}</span>;

function time(value: string | undefined, now: number) {
  if (!value) return undefined;
  return (
    <span title={new Date(value).toLocaleString()}>
      {formatAge(value, now)} ago
    </span>
  );
}

const joined = (values: unknown) =>
  Array.isArray(values) && values.length > 0 ? values.join(", ") : undefined;

const selectorText = (labels: Record<string, string> | undefined) =>
  labels && Object.keys(labels).length > 0
    ? mono(Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(", "))
    : undefined;

function controller(object: KubeObject) {
  const owner = (object.metadata?.ownerReferences ?? []).find((o: KubeObject) => o.controller);
  return owner ? `${owner.kind}/${owner.name}` : undefined;
}

/** `ready/desired` with what else the controller reports. */
function replicaSummary(status: KubeObject = {}, desired: number | undefined) {
  const ready = status.readyReplicas ?? 0;
  const parts = [`${ready}/${desired ?? 0} ready`];
  if (status.updatedReplicas !== undefined) parts.push(`${status.updatedReplicas} updated`);
  if (status.availableReplicas !== undefined) parts.push(`${status.availableReplicas} available`);
  return parts.join(", ");
}

/** The lines `kubectl describe` leads with, per kind; unknown kinds show their scalars. */
function properties(resource: string, o: KubeObject, now: number): Property[] {
  const spec = o.spec ?? {};
  const status = o.status ?? {};
  const common: Property[] = [
    ["Created", time(o.metadata?.creationTimestamp, now)],
    ["Controlled by", controller(o)],
  ];
  const specific: Property[] = (() => {
    switch (resource) {
      case "pods":
        return [
          ["Status", status.phase],
          ["Node", spec.nodeName],
          ["Pod IP", status.podIP],
          ["Host IP", status.hostIP],
          ["QoS class", status.qosClass],
          ["Service account", spec.serviceAccountName],
          ["Restart policy", spec.restartPolicy],
          ["Priority class", spec.priorityClassName],
          ["Started", time(status.startTime, now)],
        ];
      case "deployments":
        return [
          ["Replicas", replicaSummary(status, spec.replicas)],
          [
            "Strategy",
            spec.strategy?.type === "RollingUpdate"
              ? `RollingUpdate (max surge ${spec.strategy.rollingUpdate?.maxSurge ?? "25%"}, max unavailable ${spec.strategy.rollingUpdate?.maxUnavailable ?? "25%"})`
              : spec.strategy?.type,
          ],
          ["Selector", selectorText(spec.selector?.matchLabels)],
        ];
      case "statefulsets":
        return [
          ["Replicas", replicaSummary(status, spec.replicas)],
          ["Service", spec.serviceName],
          ["Update strategy", spec.updateStrategy?.type],
          ["Pod management", spec.podManagementPolicy],
          ["Selector", selectorText(spec.selector?.matchLabels)],
        ];
      case "daemonsets":
        return [
          ["Scheduled", `${status.numberReady ?? 0}/${status.desiredNumberScheduled ?? 0} ready`],
          ["Update strategy", spec.updateStrategy?.type],
          ["Node selector", selectorText(spec.template?.spec?.nodeSelector)],
          ["Selector", selectorText(spec.selector?.matchLabels)],
        ];
      case "replicasets":
        return [
          ["Replicas", replicaSummary(status, spec.replicas)],
          ["Selector", selectorText(spec.selector?.matchLabels)],
        ];
      case "jobs":
        return [
          ["Completions", `${status.succeeded ?? 0}/${spec.completions ?? 1}`],
          ["Parallelism", spec.parallelism],
          ["Failed", status.failed],
          ["Backoff limit", spec.backoffLimit],
          ["Started", time(status.startTime, now)],
          ["Completed", time(status.completionTime, now)],
        ];
      case "cronjobs":
        return [
          ["Schedule", mono(spec.schedule)],
          ["Time zone", spec.timeZone],
          ["Suspended", spec.suspend ? "Yes" : "No"],
          ["Concurrency", spec.concurrencyPolicy],
          ["Last scheduled", time(status.lastScheduleTime, now)],
          ["Last succeeded", time(status.lastSuccessfulTime, now)],
          ["Active jobs", status.active?.length ?? 0],
        ];
      case "services":
        return [
          ["Type", spec.type],
          ["Cluster IP", joined(spec.clusterIPs) ?? spec.clusterIP],
          [
            "External",
            joined((status.loadBalancer?.ingress ?? []).map((i: KubeObject) => i.ip ?? i.hostname)) ??
              joined(spec.externalIPs) ??
              spec.externalName,
          ],
          ["Session affinity", spec.sessionAffinity],
          ["Selector", selectorText(spec.selector)],
        ];
      case "ingresses":
        return [
          ["Class", spec.ingressClassName],
          [
            "Address",
            joined((status.loadBalancer?.ingress ?? []).map((i: KubeObject) => i.ip ?? i.hostname)),
          ],
          ["TLS", joined((spec.tls ?? []).flatMap((t: KubeObject) => t.hosts ?? []))],
        ];
      case "nodes": {
        const info = status.nodeInfo ?? {};
        const roles = Object.keys(o.metadata?.labels ?? {})
          .filter((k) => k.startsWith("node-role.kubernetes.io/"))
          .map((k) => k.slice("node-role.kubernetes.io/".length));
        return [
          ["Roles", joined(roles)],
          ["Schedulable", spec.unschedulable ? "No (cordoned)" : "Yes"],
          [
            "Addresses",
            joined((status.addresses ?? []).map((a: KubeObject) => `${a.address} (${a.type})`)),
          ],
          ["Kubelet", info.kubeletVersion],
          ["OS image", info.osImage],
          ["Kernel", info.kernelVersion],
          ["Runtime", info.containerRuntimeVersion],
          ["Architecture", info.architecture],
          ["Pod CIDR", spec.podCIDR],
          [
            "Capacity",
            status.capacity &&
              `${status.capacity.cpu} CPU, ${status.capacity.memory} memory, ${status.capacity.pods} pods`,
          ],
          [
            "Allocatable",
            status.allocatable &&
              `${status.allocatable.cpu} CPU, ${status.allocatable.memory} memory, ${status.allocatable.pods} pods`,
          ],
        ];
      }
      case "namespaces":
        return [["Status", status.phase]];
      case "persistentvolumeclaims":
        return [
          ["Status", status.phase],
          ["Volume", spec.volumeName],
          ["Capacity", status.capacity?.storage],
          ["Requested", spec.resources?.requests?.storage],
          ["Access modes", joined(spec.accessModes)],
          ["Storage class", spec.storageClassName],
          ["Volume mode", spec.volumeMode],
        ];
      case "persistentvolumes":
        return [
          ["Status", status.phase],
          ["Capacity", spec.capacity?.storage],
          ["Access modes", joined(spec.accessModes)],
          ["Reclaim policy", spec.persistentVolumeReclaimPolicy],
          ["Claim", spec.claimRef && `${spec.claimRef.namespace}/${spec.claimRef.name}`],
          ["Storage class", spec.storageClassName],
          [
            "Source",
            spec.csi
              ? `CSI ${spec.csi.driver}`
              : spec.hostPath
                ? `hostPath ${spec.hostPath.path}`
                : spec.nfs
                  ? `NFS ${spec.nfs.server}:${spec.nfs.path}`
                  : spec.local
                    ? `local ${spec.local.path}`
                    : undefined,
          ],
        ];
      case "storageclasses":
        return [
          ["Provisioner", o.provisioner],
          ["Reclaim policy", o.reclaimPolicy ?? "Delete"],
          ["Binding mode", o.volumeBindingMode ?? "Immediate"],
          ["Expansion", o.allowVolumeExpansion ? "Allowed" : "Not allowed"],
          ["Parameters", selectorText(o.parameters)],
        ];
      case "horizontalpodautoscalers":
        return [
          ["Target", spec.scaleTargetRef && `${spec.scaleTargetRef.kind}/${spec.scaleTargetRef.name}`],
          ["Replicas", `${status.currentReplicas ?? 0} (min ${spec.minReplicas ?? 1}, max ${spec.maxReplicas})`],
          ["Desired", status.desiredReplicas],
          ["Last scaled", time(status.lastScaleTime, now)],
        ];
      case "poddisruptionbudgets":
        return [
          ["Min available", spec.minAvailable],
          ["Max unavailable", spec.maxUnavailable],
          ["Allowed disruptions", status.disruptionsAllowed],
          ["Healthy", `${status.currentHealthy ?? 0}/${status.desiredHealthy ?? 0}`],
          ["Selector", selectorText(spec.selector?.matchLabels)],
        ];
      case "serviceaccounts":
        return [
          ["Secrets", joined((o.secrets ?? []).map((s: KubeObject) => s.name))],
          ["Pull secrets", joined((o.imagePullSecrets ?? []).map((s: KubeObject) => s.name))],
          ["Mount token", o.automountServiceAccountToken === false ? "No" : "Yes"],
        ];
      case "rolebindings":
      case "clusterrolebindings":
        return [["Role", o.roleRef && `${o.roleRef.kind}/${o.roleRef.name}`]];
      case "networkpolicies":
        return [
          ["Pod selector", selectorText(spec.podSelector?.matchLabels) ?? "All pods"],
          ["Policy types", joined(spec.policyTypes)],
          ["Ingress rules", spec.ingress?.length],
          ["Egress rules", spec.egress?.length],
        ];
      case "events":
        return [
          ["Type", o.type],
          ["Reason", o.reason],
          ["Object", o.involvedObject && `${o.involvedObject.kind}/${o.involvedObject.name}`],
          ["Message", o.message],
          ["Source", o.source?.component ?? o.reportingComponent],
          ["Count", o.count ?? o.series?.count],
          ["First seen", time(o.firstTimestamp ?? o.eventTime, now)],
          ["Last seen", time(o.lastTimestamp ?? o.series?.lastObservedTime ?? o.eventTime, now)],
        ];
      case "configmaps":
      case "secrets":
        return [["Type", o.type]];
      default:
        // Custom kinds: the plain values of their spec read well enough.
        return Object.entries(spec)
          .filter(([, v]) => v === null || typeof v !== "object")
          .slice(0, 12)
          .map(([k, v]): Property => [k, String(v)]);
    }
  })();
  return [...specific, ...common];
}

// Sections.

function Conditions({ conditions, now }: { conditions: KubeObject[] | undefined; now: number }) {
  if (!Array.isArray(conditions) || conditions.length === 0) return null;
  return (
    <Section title="Conditions">
      <ul className="flex flex-col gap-1.5">
        {conditions.map((c) => (
          <li key={c.type} className="flex items-start gap-2">
            <span className="mt-0.5">
              <StatusIcon tone={c.status === "True" ? "ok" : c.status === "False" ? "failed" : "unknown"} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span>{c.type}</span>
                {c.reason && <span className="truncate text-muted-foreground">{c.reason}</span>}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {c.lastTransitionTime && formatAge(c.lastTransitionTime, now)}
                </span>
              </div>
              {c.message && <p className="text-xs break-words text-muted-foreground">{c.message}</p>}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function resourcesText(resources: KubeObject | undefined) {
  const pair = (kind: string) => {
    const requests = resources?.requests?.[kind];
    const limits = resources?.limits?.[kind];
    if (!requests && !limits) return null;
    return `${kind} ${requests ?? "—"} / ${limits ?? "—"}`;
  };
  const parts = [pair("cpu"), pair("memory")].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** A container's state the way `kubectl describe` words it. */
function containerState(status: KubeObject | undefined, now: number) {
  const state = status?.state ?? {};
  if (state.running) return { tone: "ok" as const, text: `Running for ${formatAge(state.running.startedAt, now)}` };
  if (state.waiting) return { tone: "pending" as const, text: state.waiting.reason ?? "Waiting", detail: state.waiting.message };
  if (state.terminated) {
    const t = state.terminated;
    return {
      tone: t.exitCode === 0 ? ("done" as const) : ("failed" as const),
      text: `${t.reason ?? "Terminated"} (exit ${t.exitCode})`,
      detail: t.message,
    };
  }
  return { tone: "unknown" as const, text: "Unknown" };
}

function PodContainers({
  pod,
  onLogs,
  onShell,
}: {
  pod: KubeObject;
  onLogs: (container: string) => void;
  onShell: (container: string) => void;
}) {
  const now = useNow();
  const statuses: KubeObject[] = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  const containers: { spec: KubeObject; init: boolean }[] = [
    ...(pod.spec?.initContainers ?? []).map((spec: KubeObject) => ({ spec, init: true })),
    ...(pod.spec?.containers ?? []).map((spec: KubeObject) => ({ spec, init: false })),
  ];
  return (
    <Section title="Containers" count={containers.length}>
      <div className="flex flex-col gap-2">
        {containers.map(({ spec, init }) => {
          const status = statuses.find((s) => s.name === spec.name);
          const state = containerState(status, now);
          const last = status?.lastState?.terminated;
          return (
            <div key={spec.name} className="group rounded-lg border border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <StatusIcon tone={state.tone} />
                <span className="truncate font-medium">{spec.name}</span>
                {init && <span className="rounded bg-muted px-1 text-xs text-muted-foreground">init</span>}
                <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100">
                  <IconButton label={`Logs: ${spec.name}`} onClick={() => onLogs(spec.name)}>
                    <ScrollText />
                  </IconButton>
                  {!init && (
                    <IconButton label={`Shell: ${spec.name}`} onClick={() => onShell(spec.name)}>
                      <SquareTerminal />
                    </IconButton>
                  )}
                </span>
              </div>
              <Properties
                rows={[
                  ["State", state.text],
                  ["Message", state.detail],
                  ["Image", mono(spec.image)],
                  ["Ready", status ? (status.ready ? "Yes" : "No") : undefined],
                  ["Restarts", status?.restartCount || undefined],
                  [
                    "Last exit",
                    last && `${last.reason ?? "Terminated"} (exit ${last.exitCode}) ${formatAge(last.finishedAt, now)} ago`,
                  ],
                  [
                    "Ports",
                    joined((spec.ports ?? []).map((p: KubeObject) => `${p.containerPort}/${p.protocol ?? "TCP"}${p.name ? ` (${p.name})` : ""}`)),
                  ],
                  ["Requests / limits", resourcesText(spec.resources)],
                ]}
              />
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** The containers a workload's pods are made from. */
function TemplateContainers({ object }: { object: KubeObject }) {
  const template = object.spec?.template?.spec ?? object.spec?.jobTemplate?.spec?.template?.spec;
  const containers: KubeObject[] = template?.containers ?? [];
  if (containers.length === 0) return null;
  return (
    <Section title="Containers" count={containers.length}>
      <div className="flex flex-col gap-2">
        {containers.map((c) => (
          <div key={c.name} className="rounded-lg border border-border px-3 py-2">
            <div className="truncate font-medium">{c.name}</div>
            <Properties
              rows={[
                ["Image", mono(c.image)],
                ["Ports", joined((c.ports ?? []).map((p: KubeObject) => `${p.containerPort}/${p.protocol ?? "TCP"}`))],
                ["Requests / limits", resourcesText(c.resources)],
              ]}
            />
          </div>
        ))}
      </div>
    </Section>
  );
}

function Pods({ pods, now, onOpen }: { pods: PodRow[]; now: number; onOpen: (pod: PodRow) => void }) {
  return (
    <Section title="Pods" count={pods.length}>
      {pods.length === 0 ? (
        <p className="text-muted-foreground">No pods.</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {pods.map((pod) => (
            <li key={pod.uid}>
              <button
                onClick={() => onOpen(pod)}
                className="group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-100 hover:bg-accent"
              >
                <StatusIcon tone={statusTone(pod.status)} />
                <span className="min-w-0 flex-1 truncate">{pod.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {pod.status} · {pod.ready}/{pod.containers}
                  {pod.restarts > 0 && ` · ${pod.restarts}↻`} · {formatAge(pod.createdAt, now)}
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Sections only some kinds have: ports, rules, data, taints, subjects. */
function KindSections({ resource, object }: { resource: string; object: KubeObject }) {
  const spec = object.spec ?? {};
  switch (resource) {
    case "services":
      return (
        <Table
          title="Ports"
          head={["Name", "Port", "Target", "Node port"]}
          rows={(spec.ports ?? []).map((p: KubeObject) => [
            p.name ?? "—",
            `${p.port}/${p.protocol ?? "TCP"}`,
            String(p.targetPort ?? p.port),
            p.nodePort ? String(p.nodePort) : "—",
          ])}
        />
      );
    case "ingresses":
      return (
        <Table
          title="Rules"
          head={["Host", "Path", "Backend"]}
          rows={(spec.rules ?? []).flatMap((r: KubeObject) =>
            (r.http?.paths ?? []).map((p: KubeObject) => [
              r.host ?? "*",
              p.path ?? "/",
              p.backend?.service
                ? `${p.backend.service.name}:${p.backend.service.port?.number ?? p.backend.service.port?.name}`
                : (p.backend?.resource?.name ?? "—"),
            ]),
          )}
        />
      );
    case "configmaps":
      return <Data data={{ ...object.data, ...object.binaryData }} />;
    case "secrets":
      return <Data data={object.data} secret />;
    case "nodes":
      return (
        <Table
          title="Taints"
          head={["Key", "Value", "Effect"]}
          rows={(spec.taints ?? []).map((t: KubeObject) => [t.key, t.value ?? "—", t.effect])}
        />
      );
    case "roles":
    case "clusterroles":
      return (
        <Table
          title="Rules"
          head={["Resources", "Verbs"]}
          rows={(object.rules ?? []).map((r: KubeObject) => [
            joined(r.resources) ?? joined(r.nonResourceURLs) ?? "—",
            joined(r.verbs) ?? "—",
          ])}
        />
      );
    case "rolebindings":
    case "clusterrolebindings":
      return (
        <Table
          title="Subjects"
          head={["Kind", "Name", "Namespace"]}
          rows={(object.subjects ?? []).map((s: KubeObject) => [s.kind, s.name, s.namespace ?? "—"])}
        />
      );
    default:
      return null;
  }
}

function Table({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  if (rows.length === 0) return null;
  return (
    <Section title={title} count={rows.length}>
      <table className="w-full table-fixed text-left">
        <thead className="text-xs text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="pb-1 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border/50">
              {row.map((cell, j) => (
                <td key={j} className="truncate py-1 pr-2 align-top" title={cell}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** Base64 to text, or `null` for binary data that would print as noise. */
function decode(value: string) {
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A ConfigMap's or Secret's keys; secret values stay hidden until asked. */
function Data({ data, secret }: { data: Record<string, string> | undefined; secret?: boolean }) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const entries = Object.entries(data ?? {});
  if (entries.length === 0) return null;
  const toggle = (key: string) =>
    setRevealed((r) => {
      const next = new Set(r);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <Section title="Data" count={entries.length}>
      <div className="flex flex-col gap-2">
        {entries.map(([key, value]) => {
          const shown = !secret || revealed.has(key);
          const text = secret ? (decode(value) ?? "(binary)") : value;
          return (
            <div key={key} className="rounded-lg border border-border">
              <div className="flex h-7 items-center gap-2 border-b border-border/50 px-3">
                <span className="truncate font-mono text-xs">{key}</span>
                {secret && (
                  <span className="ml-auto">
                    <IconButton label={shown ? "Hide value" : "Show value"} onClick={() => toggle(key)}>
                      {shown ? <EyeOff /> : <Eye />}
                    </IconButton>
                  </span>
                )}
              </div>
              <pre className="max-h-48 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all select-text">
                {shown ? text : "••••••••"}
              </pre>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function Labels({ title, labels }: { title: string; labels: Record<string, string> | undefined }) {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) return null;
  return (
    <Section title={title} count={entries.length}>
      <div className="flex flex-wrap gap-1">
        {entries.map(([k, v]) => (
          <span
            key={k}
            title={`${k}=${v}`}
            className="max-w-full truncate rounded-md border border-border px-1.5 py-0.5 font-mono text-xs select-text"
          >
            {k}
            {v && <span className="text-muted-foreground">={v}</span>}
          </span>
        ))}
      </div>
    </Section>
  );
}

/** Long values (like last-applied-configuration) start folded. */
function Annotations({ annotations }: { annotations: Record<string, string> | undefined }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const entries = useMemo(() => Object.entries(annotations ?? {}), [annotations]);
  if (entries.length === 0) return null;
  return (
    <Section title="Annotations" count={entries.length}>
      <dl className="flex flex-col gap-1.5">
        {entries.map(([key, value]) => {
          const long = value.length > 120;
          const expanded = !long || open.has(key);
          return (
            <div key={key} className="min-w-0">
              <dt className="truncate font-mono text-xs text-muted-foreground" title={key}>
                {key}
              </dt>
              <dd
                onClick={() => long && setOpen((o) => new Set(o).add(key))}
                className={cn(
                  "font-mono text-xs break-all select-text",
                  !expanded && "line-clamp-2 cursor-pointer hover:text-foreground/80",
                )}
              >
                {value}
              </dd>
            </div>
          );
        })}
      </dl>
    </Section>
  );
}

function Events({ events, now }: { events: Details["events"]; now: number }) {
  return (
    <Section title="Events" count={events.length}>
      {events.length === 0 ? (
        <p className="text-muted-foreground">No recent events.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-2">
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  e.kind === "Warning" ? "bg-warning" : "bg-muted-foreground/60",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={cn(e.kind === "Warning" && "text-warning")}>{e.reason}</span>
                  {e.count > 1 && <span className="text-xs text-muted-foreground">×{e.count}</span>}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {formatAge(e.lastSeen, now)}
                  </span>
                </div>
                <p className="text-xs break-words text-muted-foreground select-text">{e.message}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
