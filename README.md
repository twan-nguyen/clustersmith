# ClusterSmith

A fast, focused Kubernetes desktop client. Tauri 2 with a Rust backend
([kube-rs](https://kube.rs)) and a React UI.

The Rust side owns cluster data: it watches resources through a reflector cache
and pushes coalesced snapshots to the UI, so the webview only renders what is on
screen.

## Requirements

- Rust (install with [rustup](https://rustup.rs))
- Node 20+ and pnpm
- A kubeconfig: `~/.kube/config`, `$KUBECONFIG`, or any file added in Settings (`⌘,`)

## Development

```bash
pnpm install
pnpm tauri dev
```

Build a release bundle with `pnpm tauri build`.

The window uses `macOSPrivateApi` for its translucent background, which the Mac
App Store does not accept; distribute outside the store.

## Layout

- `src-tauri/src/kubeconfig.rs`: settings file, kubeconfig sources, cluster names and colors
- `src-tauri/src/clients.rs`: one cached API client per kubeconfig context
- `src-tauri/src/contexts.rs`: kubeconfig contexts and namespaces
- `src-tauri/src/watch.rs`: live list watch shared by every kind, batched every 150 ms
- `src-tauri/src/pods.rs`, `resources.rs`: pods, and the other kinds with their columns
- `src-tauri/src/custom.rs`: custom resource kinds, read through their printer columns
- `src-tauri/src/details.rs`: the details panel's object, events and pods
- `src-tauri/src/metrics.rs`: CPU and memory from metrics-server
- `src-tauri/src/nodes.rs`: cordon, uncordon and drain
- `src-tauri/src/actions.rs`: delete, restart, scale, YAML edit, and create from YAML
- `src-tauri/src/logs.rs`, `shell.rs`, `sessions.rs`: log streams and `exec` shells in the dock
- `src-tauri/src/forwards.rs`: port forwards to pods and services, one stream per connection
- `src-tauri/src/appearance.rs`: window translucency
- `src/store.ts`: UI state, the live list subscription and dock tabs
- `src/components/`: sidebar, resource lists, details panel, dock, Settings (`⌘,`), command palette (`⌘K`)
