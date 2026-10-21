import { Box, Cable, FilePlus, Layers, Server, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { KindIcon } from "@/components/kind-icon";
import { contextLabel } from "@/lib/kube";
import { templateFor } from "@/lib/templates";
import { findKind, useStore } from "@/store";

/** Pods can number in the thousands; the palette shows the best few. */
const MAX_POD_RESULTS = 50;

export function CommandPalette() {
  const {
    paletteOpen,
    setPaletteOpen,
    contexts,
    namespaces,
    pods,
    selectContext,
    selectNamespace,
    setQuery,
    setView,
    kinds,
    customKinds,
    selectKind,
    context,
    namespace,
    openTab,
    select,
  } = useStore();
  const [search, setSearch] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen(!useStore.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setPaletteOpen]);

  useEffect(() => {
    if (!paletteOpen) setSearch("");
  }, [paletteOpen]);

  const needle = search.trim().toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(needle);

  const podResults = useMemo(
    () => pods.filter((p) => p.name.toLowerCase().includes(needle)).slice(0, MAX_POD_RESULTS),
    [pods, needle],
  );

  const run = (action: () => void) => {
    action();
    setPaletteOpen(false);
  };

  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      <Command shouldFilter={false}>
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder="Jump to a kind, context, namespace or pod…"
        />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>

          <CommandGroup heading="Actions">
            {context && (matches("create resource") || matches("new yaml")) && (
              <CommandItem
                value="action:create"
                onSelect={() =>
                  run(() => {
                    const kind = findKind(useStore.getState(), useStore.getState().kind);
                    openTab({ kind: "create", context, namespace, template: templateFor(kind, namespace) });
                  })
                }
              >
                <FilePlus />
                Create resource from YAML…
              </CommandItem>
            )}
            {matches("port forwards") && (
              <CommandItem value="action:forwards" onSelect={() => run(() => setView("forwards"))}>
                <Cable />
                Port Forwards
              </CommandItem>
            )}
            {(matches("settings") || matches("clusters") || matches("kubeconfig files")) && (
              <CommandItem value="action:settings" onSelect={() => run(() => setView("settings"))}>
                <Settings />
                Settings
                <CommandShortcut>⌘,</CommandShortcut>
              </CommandItem>
            )}
          </CommandGroup>

          <CommandGroup heading="Go to">
            {kinds
              .filter((k) => matches(k.label))
              .map((k) => (
                <CommandItem
                  key={k.id}
                  value={`kind:${k.id}`}
                  onSelect={() => run(() => selectKind(k.id))}
                >
                  <KindIcon kind={k.id} />
                  {k.label}
                  <span className="ml-auto text-xs text-muted-foreground">{k.section}</span>
                </CommandItem>
              ))}
            {/* Custom kinds can be many; they show once something is typed. */}
            {needle &&
              customKinds
                .filter((k) => matches(k.label) || matches(k.group))
                .slice(0, MAX_POD_RESULTS)
                .map((k) => (
                  <CommandItem
                    key={k.id}
                    value={`kind:${k.id}`}
                    onSelect={() => run(() => selectKind(k.id))}
                  >
                    <KindIcon kind={k.id} />
                    {k.label}
                    <span className="ml-auto truncate text-xs text-muted-foreground">{k.group}</span>
                  </CommandItem>
                ))}
          </CommandGroup>

          <CommandGroup heading="Contexts">
            {contexts
              .filter((c) => matches(contextLabel(c)) || matches(c.name))
              .map((c) => (
                <CommandItem
                  key={c.name}
                  value={`context:${c.name}`}
                  onSelect={() => run(() => selectContext(c.name))}
                >
                  <Server />
                  {contextLabel(c)}
                </CommandItem>
              ))}
          </CommandGroup>

          <CommandGroup heading="Namespaces">
            {namespaces.filter(matches).map((ns) => (
              <CommandItem
                key={ns}
                value={`namespace:${ns}`}
                onSelect={() => run(() => selectNamespace(ns))}
              >
                <Layers />
                {ns}
              </CommandItem>
            ))}
          </CommandGroup>

          {needle && (
            <CommandGroup heading="Pods">
              {podResults.map((p) => (
                <CommandItem
                  key={p.uid}
                  value={`pod:${p.uid}`}
                  onSelect={() =>
                    run(() => {
                      setQuery(p.name);
                      if (context) select({ context, resource: "pods", namespace: p.namespace, name: p.name, uid: p.uid });
                    })
                  }
                >
                  <Box />
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{p.namespace}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
