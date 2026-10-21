import { Check, ChevronDown, Layers } from "lucide-react";
import { useState } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage } from "@/lib/utils";
import { useStore } from "@/store";

const ALL = "__all__";

export function NamespaceFilter() {
  const { namespaces, namespace, selectNamespace, refreshNamespaces } = useStore();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Namespaces come and go, so the list is fetched again on every open.
  const toggle = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setError(null);
    setLoading(true);
    refreshNamespaces()
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  };

  const choose = (value: string | null) => {
    selectNamespace(value);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <button className="group flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground data-[state=open]:bg-accent">
          <Layers className="size-3.5" />
          <span className="max-w-48 truncate text-foreground">{namespace ?? "All namespaces"}</span>
          <ChevronDown className="size-3 transition-transform duration-150 ease-out-quart group-data-[state=open]:rotate-180" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Filter namespaces…" />
          <CommandList>
            <CommandEmpty>No namespace found.</CommandEmpty>
            {namespaces.length === 0 && (loading || error) && (
              <div className="truncate px-3 py-2 text-xs text-muted-foreground" title={error ?? undefined}>
                {loading ? "Loading namespaces…" : `Can't load namespaces: ${error}`}
              </div>
            )}
            <CommandGroup>
              <CommandItem value={ALL} onSelect={() => choose(null)}>
                <Layers />
                All namespaces
                {namespace === null && <Check className="ml-auto" />}
              </CommandItem>
              {namespaces.map((ns) => (
                <CommandItem key={ns} value={ns} onSelect={() => choose(ns)}>
                  <span className="size-4" />
                  <span className="truncate">{ns}</span>
                  {namespace === ns && <Check className="ml-auto" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
