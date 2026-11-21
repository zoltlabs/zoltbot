// M4: Import memory… on the Memory page. The owner picks an export from ChatGPT, Claude or Gemini;
// what it finds waits in Needs review.
import { createSignal, onCleanup, Show } from "solid-js";
import type {
  MemoryImportChoice,
  MemoryImportSource,
  MemoryImportStatus,
} from "../../../shared/memory";
import { t } from "../i18n";
import { ConfirmDialog, Menu } from "../kit";
import { memoryError } from "../memory-store";

const SOURCES: { id: MemoryImportSource; label: string }[] = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude", label: "Claude" },
  { id: "gemini", label: "Gemini" },
];
const labelOf = (source: MemoryImportSource) =>
  SOURCES.find((entry) => entry.id === source)?.label ?? source;

/** The menu button for the toolbar. */
export function MemoryImportButton(props: {
  busy: boolean;
  onPick: (source: MemoryImportSource) => void;
}) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  return (
    <>
      <button
        ref={button}
        type="button"
        class="zb-kit-button memory-import"
        aria-haspopup="menu"
        aria-expanded={open()}
        disabled={props.busy}
        onClick={() => setOpen(!open())}
      >
        {t("memory.import.button")}
      </button>
      <Show when={open() && button}>
        {(anchor) => (
          <Menu
            anchor={anchor()}
            label={t("memory.import.menu")}
            groups={[
              SOURCES.map((source) => ({
                id: source.id,
                label: source.label,
                run: () => props.onPick(source.id),
              })),
            ]}
            onClose={() => setOpen(false)}
          />
        )}
      </Show>
    </>
  );
}

/** Picks the file, confirms, then shows progress until the facts are in Needs review. */
export function createMemoryImport() {
  const api = () => window.openbot.memory;
  const [choice, setChoice] = createSignal<MemoryImportChoice | null>(null);
  const [status, setStatus] = createSignal<MemoryImportStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Each start or dismiss begins a new generation; answers from an older one are ignored.
  let generation = 0;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    clearTimeout(timer);
  });

  function follow(next: MemoryImportStatus, mine: number) {
    if (disposed || mine !== generation) return;
    setStatus(next);
    if (next.state !== "reading") return;
    timer = setTimeout(() => {
      void api()
        .importStatus(next.id)
        .then((later) => follow(later, mine))
        .catch((failure) => {
          if (disposed || mine !== generation) return;
          setStatus({ ...next, state: "failed", error: memoryError(failure) });
        });
    }, 1000);
  }

  return {
    choice,
    status,
    busy,
    error,
    async pick(source: MemoryImportSource) {
      if (busy()) return;
      setError(null);
      setBusy(true);
      try {
        const picked = await api().importChoose(source);
        if (!picked) return;
        if (!picked.memories && !picked.conversations)
          setError(t("memory.import.empty", { source: labelOf(source) }));
        else setChoice(picked);
      } catch (failure) {
        setError(memoryError(failure));
      } finally {
        setBusy(false);
      }
    },
    cancel() {
      setChoice(null);
      setError(null);
    },
    async start() {
      const picked = choice();
      if (!picked || busy()) return;
      setBusy(true);
      setError(null);
      try {
        const started = await api().importStart({ source: picked.source, path: picked.path });
        setChoice(null);
        clearTimeout(timer);
        follow(started, ++generation);
      } catch (failure) {
        setError(memoryError(failure));
      } finally {
        setBusy(false);
      }
    },
    dismiss() {
      generation++;
      clearTimeout(timer);
      setStatus(null);
    },
  };
}
export type MemoryImport = ReturnType<typeof createMemoryImport>;

/** The confirmation and the progress line under the toolbar. */
export function MemoryImportStatusView(props: { import: MemoryImport; onReview: () => void }) {
  const run = () => props.import;
  return (
    <>
      <Show when={run().choice()}>
        {(picked) => (
          <ConfirmDialog
            title={t("memory.import.title", { source: labelOf(picked().source) })}
            body={t("memory.import.body", {
              name: picked().name,
              memories: picked().memories,
              conversations: picked().conversations,
            })}
            confirmLabel={t("memory.import.confirm")}
            busyLabel={t("memory.import.starting")}
            busy={run().busy()}
            error={run().error()}
            onCancel={() => run().cancel()}
            onConfirm={() => void run().start()}
          />
        )}
      </Show>
      <Show when={!run().choice() && run().error()}>
        {(message) => (
          <p class="memory-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={run().status()}>
        {(current) => (
          <div class="memory-import-status" role="status">
            <Show
              when={current().state === "reading"}
              fallback={
                <Show
                  when={current().state === "done"}
                  fallback={<span>{current().error ?? t("memory.import.failed")}</span>}
                >
                  <span>{t("memory.import.done", { count: current().proposed })}</span>
                  <Show when={current().proposed > 0}>
                    <button type="button" class="zb-kit-button" onClick={props.onReview}>
                      {t("memory.import.review")}
                    </button>
                  </Show>
                </Show>
              }
            >
              <span>
                {t("memory.import.reading", {
                  read: current().read,
                  count: current().conversations,
                })}
              </span>
            </Show>
            <Show when={current().state !== "reading"}>
              <button type="button" class="zb-kit-button" onClick={() => run().dismiss()}>
                {t("memory.import.dismiss")}
              </button>
            </Show>
          </div>
        )}
      </Show>
    </>
  );
}
