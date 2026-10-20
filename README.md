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

## Layout

- `src-tauri/src/kubeconfig.rs`: kubeconfig files, default ones plus those added in Settings
- `src-tauri/src/clients.rs`: one cached API client per kubeconfig context
- `src-tauri/src/contexts.rs`: kubeconfig contexts and namespaces
- `src-tauri/src/pods.rs`: pod watch, batched every 150 ms
- `src/store.ts`: UI state and the live pod subscription
- `src/components/`: sidebar, pods table, Settings (`⌘,`), command palette (`⌘K`)
