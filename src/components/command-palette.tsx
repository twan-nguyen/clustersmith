import { Box, Layers, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useStore } from "@/store";

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
          placeholder="Jump to a context, namespace or pod…"
        />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>

          <CommandGroup heading="Contexts">
            {contexts
              .filter((c) => matches(c.name))
              .map((c) => (
                <CommandItem
                  key={c.name}
                  value={`context:${c.name}`}
                  onSelect={() => run(() => selectContext(c.name))}
                >
                  <Server />
                  {c.name}
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
                  onSelect={() => run(() => setQuery(p.name))}
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
