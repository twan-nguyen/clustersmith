import { yaml } from "@codemirror/lang-yaml";
import { EditorState, Prec } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { applyResourceYaml, createResources, getResourceYaml } from "@/lib/kube";
import { cn, errorMessage } from "@/lib/utils";
import type { CreateTab, YamlTab } from "@/store";

/** Blends One Dark into the panel: no own background, the app's mono font. */
const PANEL_THEME = EditorView.theme(
  {
    "&": { height: "100%", fontSize: "12px", backgroundColor: "transparent" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', lineHeight: "1.5" },
    ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  },
  { dark: true },
);

/** A YAML editor in `parent` where ⌘S calls whatever `save` currently is. */
function createEditor(
  parent: HTMLElement,
  doc: string,
  save: React.RefObject<() => void>,
  onChange: (text: string) => void,
) {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        Prec.high(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (save.current(), true) }])),
        basicSetup,
        yaml(),
        oneDark,
        PANEL_THEME,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
}

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * Edits one object's YAML, like Lens's edit tab. Saving replaces the object;
 * if someone changed it since it was loaded, the server refuses and the
 * error says so, so nothing is overwritten by accident.
 */
export function YamlView({ tab, active }: { tab: YamlTab; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const saved = useRef("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [dirty, setDirty] = useState(false);
  // The editor's keymap is built once; it calls whatever `save` is current.
  const saveRef = useRef(() => {});

  function load(text: string) {
    const view = editor.current;
    if (!view) return;
    saved.current = text;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    setDirty(false);
  }

  async function save() {
    const view = editor.current;
    if (!view || !dirty || status.kind === "saving") return;
    setStatus({ kind: "saving" });
    try {
      load(await applyResourceYaml(tab, view.state.doc.toString()));
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    }
  }
  saveRef.current = save;

  async function reload() {
    setStatus({ kind: "loading" });
    try {
      load(await getResourceYaml(tab));
      setStatus({ kind: "ready" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    }
  }

  useEffect(() => {
    const view = createEditor(host.current!, "", saveRef, (text) =>
      setDirty(text !== saved.current),
    );
    editor.current = view;

    let cancelled = false;
    getResourceYaml(tab)
      .then((text) => {
        if (cancelled) return;
        load(text);
        setStatus({ kind: "ready" });
      })
      .catch((err) => !cancelled && setStatus({ kind: "error", message: errorMessage(err) }));

    return () => {
      cancelled = true;
      view.destroy();
      editor.current = null;
    };
  }, [tab]);

  useEffect(() => {
    if (active) editor.current?.focus();
  }, [active]);

  const path = [tab.resource, tab.namespace, tab.name].filter(Boolean).join(" / ");

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-xs">
        <span className="truncate text-muted-foreground" title={path}>
          {path}
        </span>
        <StatusLabel status={status} dirty={dirty} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            onClick={reload}
            disabled={status.kind === "loading" || status.kind === "saving"}
            title="Load the object as the cluster has it now"
            className="flex h-6 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <RotateCcw className="size-3.5" />
            {dirty ? "Discard changes" : "Reload"}
          </button>
          <Button
            size="xs"
            onClick={save}
            disabled={!dirty || status.kind === "saving"}
            className="gap-1.5"
          >
            Save
            <Kbd className="bg-primary-foreground/15 text-primary-foreground">⌘S</Kbd>
          </Button>
        </div>
      </div>
      <div ref={host} className="min-h-0 flex-1 select-text" />
    </div>
  );
}

function StatusLabel({ status, dirty }: { status: Status; dirty: boolean }) {
  if (status.kind === "error") {
    return (
      <span className="truncate text-destructive" title={status.message}>
        {status.message}
      </span>
    );
  }
  const label =
    status.kind === "loading"
      ? "Loading…"
      : status.kind === "saving"
        ? "Saving…"
        : dirty
          ? "Modified"
          : status.kind === "saved"
            ? "Saved"
            : null;
  if (!label) return null;
  return (
    <span className="flex shrink-0 animate-fade-in items-center gap-1.5 text-muted-foreground">
      <span
        className={cn(
          "size-1.5 rounded-full",
          dirty ? "bg-warning" : status.kind === "saved" ? "bg-success" : "bg-muted-foreground/60",
        )}
      />
      {label}
    </span>
  );
}

type CreateStatus =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "created"; names: string[] }
  | { kind: "error"; message: string };

/**
 * Writes new objects from scratch, like `kubectl create -f`. Several can be
 * created at once, separated by `---`; the live lists then show them.
 */
export function CreateView({ tab, active }: { tab: CreateTab; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const [status, setStatus] = useState<CreateStatus>({ kind: "idle" });
  const createRef = useRef(() => {});

  async function create() {
    const view = editor.current;
    if (!view || status.kind === "creating") return;
    setStatus({ kind: "creating" });
    try {
      const names = await createResources(tab.context, tab.namespace, view.state.doc.toString());
      setStatus({ kind: "created", names });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    }
  }
  createRef.current = create;

  useEffect(() => {
    // Editing after a result clears it, so the label always describes the text.
    const view = createEditor(host.current!, tab.template, createRef, () =>
      setStatus((s) => (s.kind === "creating" ? s : { kind: "idle" })),
    );
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [tab]);

  useEffect(() => {
    if (active) editor.current?.focus();
  }, [active]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-xs">
        <span className="shrink-0 text-muted-foreground">
          New resource{tab.namespace ? ` in ${tab.namespace}` : ""}
        </span>
        {status.kind === "error" ? (
          <span className="truncate text-destructive" title={status.message}>
            {status.message}
          </span>
        ) : status.kind === "created" ? (
          <span className="flex min-w-0 animate-fade-in items-center gap-1.5 text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-success" />
            <span className="truncate">Created {status.names.join(", ")}</span>
          </span>
        ) : status.kind === "creating" ? (
          <span className="text-muted-foreground">Creating…</span>
        ) : null}
        <Button
          size="xs"
          onClick={create}
          disabled={status.kind === "creating"}
          className="ml-auto shrink-0 gap-1.5"
        >
          Create
          <Kbd className="bg-primary-foreground/15 text-primary-foreground">⌘S</Kbd>
        </Button>
      </div>
      <div ref={host} className="min-h-0 flex-1 select-text" />
    </div>
  );
}
