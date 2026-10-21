<p align="center">
  <img src="app-icon.svg" width="96" alt="ClusterSmith icon">
</p>

<h1 align="center">ClusterSmith</h1>

<p align="center">
  A fast, focused Kubernetes desktop client built with Tauri, Rust and React.
</p>

ClusterSmith is a desktop app for working with Kubernetes clusters day to day:
browsing resources, reading logs, opening shells, forwarding ports and making
quick changes. It keeps the parts of Lens and Freelens that get used every day
and leaves out the rest, with a quiet interface in the style of Linear.

The Rust backend, built on [kube-rs](https://kube.rs), owns all cluster data.
It watches resources through a reflector cache and sends the UI batched
snapshots, so the webview only renders what is on screen and stays responsive
on clusters with thousands of pods.

> **Status:** early and in active development. It is built and tested on
> macOS; Windows and Linux builds are untested. There are no prebuilt releases
> yet, so build it from source.

## Features

**Clusters**
- Reads `~/.kube/config` or `$KUBECONFIG`, plus any kubeconfig files you add in
  Settings. Files are referenced by path, never copied or modified.
- Each context resolves names in its own file, so clusters exported by kubeadm
  (all called `kubernetes`) never get mixed up.
- Connects only to the cluster you pick, with progress and a retry when it
  cannot be reached (for example when its VPN is off).
- Give each cluster a display name and color; it reopens on the kind and
  namespace you left it on.

**Resources**
- Live lists for Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets,
  Jobs, CronJobs, Services, Ingresses, Network Policies, ConfigMaps, Secrets,
  Autoscalers, Disruption Budgets, Volume Claims, Volumes, Storage Classes,
  Service Accounts, Roles and bindings, Nodes, Namespaces and Events.
- Custom resources, grouped by API group, with the columns their definitions
  declare.
- A details panel like `kubectl describe`: properties, conditions, containers,
  the pods behind a workload or service, labels, annotations, ConfigMap and
  Secret data (secrets stay hidden until revealed), and recent events.
- CPU and memory for pods and nodes when metrics-server is installed.

**Actions**
- Edit any object as YAML, or create new objects from YAML.
- Delete, restart and scale, one at a time or in bulk.
- Cordon, uncordon and drain nodes, respecting disruption budgets.

**Dock**
- Logs that follow, reconnect after a dropped connection, filter with
  highlighting and save to a file. Also the previous run of a crashed
  container, and every pod of a workload in one tab.
- Shells into containers.
- Port forwards to pods and services. A service forward picks a ready pod and
  moves to another when that pod goes away.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `⌘K` | Command palette: kinds, clusters, namespaces, pods, actions |
| `⌘,` | Settings |
| `j` / `k` or `↓` / `↑` | Move through the list |
| `Enter` | Open the details panel |
| `Esc` | Clear the marked rows, then close the details panel |
| `/` | Filter the list by name |
| `x`, `⌘A` | Mark a row, or all rows, for a bulk action |
| `e` | Edit as YAML |
| `⌫` | Delete |
| `l`, `s`, `p` | On a pod: logs, shell, previous logs |
| `⌘F` | Filter the open log |
| `⌘S` | Save the YAML being edited, or create from it |

## Building from source

### Requirements

- Rust 1.88 or newer, installed with [rustup](https://rustup.rs)
- Node.js 20.19 or newer, and [pnpm](https://pnpm.io)
- The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your
  platform (on macOS, the Xcode Command Line Tools)

### Run in development

```bash
pnpm install
pnpm tauri dev
```

### Build the app

```bash
pnpm tauri build
```

The bundles land in `src-tauri/target/release/bundle/`.

### Tests and checks

```bash
cd src-tauri && cargo test && cargo clippy --all-targets
```

```bash
pnpm exec tsc --noEmit
```

## Notes

- **Settings** live in `~/Library/Application Support/com.clustersmith.desktop/settings.json`
  on macOS: the added kubeconfig paths, cluster names and colors, and the
  window transparency.
- **macOS privacy:** kubeconfig files inside `~/Documents`, `~/Desktop` or
  `~/Downloads` need the app (or, in development, your terminal) to have access
  to that folder. Keeping them in `~/.kube` avoids the prompt.
- **Mac App Store:** the translucent window uses Tauri's `macOSPrivateApi`,
  which the App Store does not accept, so ClusterSmith is distributed outside it.

## Project layout

**Rust** (`src-tauri/src/`)

| File | Responsibility |
| --- | --- |
| `kubeconfig.rs` | Settings file, kubeconfig sources, cluster names and colors |
| `clients.rs` | One cached API client per context |
| `contexts.rs` | Contexts and namespaces |
| `watch.rs` | The live list watch every kind shares, batched every 150 ms |
| `pods.rs`, `resources.rs` | Pods, and the built-in kinds with their columns |
| `custom.rs` | Custom resource kinds and their printer columns |
| `details.rs` | The details panel's object, events and pods |
| `metrics.rs` | CPU and memory from metrics-server |
| `actions.rs` | Delete, restart, scale, YAML edit and create |
| `nodes.rs` | Cordon, uncordon and drain |
| `logs.rs`, `shell.rs`, `sessions.rs` | Log streams and shells in the dock |
| `forwards.rs` | Port forwards, one stream per connection |
| `appearance.rs` | Window translucency |

**React** (`src/`)

| Path | Responsibility |
| --- | --- |
| `store.ts` | UI state, the live list subscription and dock tabs |
| `lib/kube.ts` | Typed calls into the Rust commands |
| `components/` | Sidebar, lists, details panel, dock, Settings and command palette |

## License

[MIT](LICENSE)
