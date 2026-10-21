import {
  Activity,
  Box,
  CalendarClock,
  Copy,
  Database,
  FileCog,
  FolderTree,
  Globe,
  KeyRound,
  ListChecks,
  Network,
  Rocket,
  Server,
  Shapes,
} from "lucide-react";

const ICONS: Record<string, React.ComponentType> = {
  pods: Box,
  deployments: Rocket,
  statefulsets: Database,
  daemonsets: Copy,
  jobs: ListChecks,
  cronjobs: CalendarClock,
  services: Network,
  ingresses: Globe,
  configmaps: FileCog,
  secrets: KeyRound,
  nodes: Server,
  namespaces: FolderTree,
  events: Activity,
};

/** The icon for a kind, by its id; unknown kinds get a generic shape. */
export function KindIcon({ kind }: { kind: string }) {
  const Icon = ICONS[kind] ?? Shapes;
  return <Icon />;
}
