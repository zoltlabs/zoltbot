import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import type { DocumentVersion } from "../../../shared/documents";
import { ChangesView } from "./ChangesView";
import { ConfirmDialog } from "./Dialog";
import { type DocumentsStore, errorText } from "./documents-store";

const KIND_LABELS: Record<DocumentVersion["kind"], string> = {
  saved: "Saved",
  outside: "Changed",
  "before-send": "Before sending comments",
  "before-restore": "Before restoring",
  commit: "Commit",
};

export function versionTitle(version: DocumentVersion): string {
  if (version.kind === "commit") return version.message || "Commit";
  if (version.kind === "outside") return `Changed by ${version.author}`;
  return KIND_LABELS[version.kind];
}

const when = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );

/**
 * Earlier versions of the document: ones the shell kept as the person and agents changed it, and
 * the file's git commits. Choosing one compares it with the document as it is now.
 */
export function HistoryPanel(props: { store: DocumentsStore }) {
  const store = props.store;
  // Keyed by the document, so saving doesn't count as a new document.
  const key = createMemo(() => {
    const current = store.document();
    return current ? JSON.stringify([current.projectId, current.path]) : null;
  });
  const ref = () => {
    const value = key();
    if (!value) return null;
    const [projectId, path] = JSON.parse(value) as [string, string];
    return { projectId, path };
  };
  const [versions, { refetch }] = createResource(ref, (input) =>
    window.openbot.documents.history(input),
  );
  createEffect(on(key, () => setSelected(null), { defer: true }));
  const [selected, setSelected] = createSignal<string | null>(null);
  const [confirmRestore, setConfirmRestore] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedText] = createResource(
    () => {
      const input = ref();
      const id = selected();
      return input && id ? { ...input, versionId: id } : null;
    },
    (input) => window.openbot.documents.versionText(input),
  );
  createEffect(
    on(
      () => store.document()?.hash,
      () => void refetch(),
      { defer: true },
    ),
  );

  const version = () => versions.latest?.find((row) => row.id === selected()) ?? null;

  async function restore() {
    const input = ref();
    const id = selected();
    if (!input || !id) return;
    setError(null);
    try {
      await store.flush();
      store.load(
        await window.openbot.documents.restore({
          ...input,
          versionId: id,
          baseHash: store.document()?.hash ?? null,
        }),
      );
      store.setMode("write");
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  async function reviewSince() {
    const input = ref();
    const id = selected();
    if (!input || !id) return;
    setError(null);
    try {
      await store.flush();
      store.load(await window.openbot.documents.startReview({ ...input, versionId: id }));
      store.setMode("review");
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  return (
    <div class="doc-history">
      <nav class="doc-history-list" aria-label="Versions">
        <Show
          when={(versions.latest ?? []).length > 0}
          fallback={
            <p class="doc-muted">
              {versions.loading
                ? "Loading versions…"
                : "No earlier versions yet. Versions appear as you and agents change the document."}
            </p>
          }
        >
          <ul>
            <For each={versions.latest}>
              {(row) => (
                <li>
                  <button
                    type="button"
                    class="doc-history-row"
                    aria-current={selected() === row.id ? "true" : undefined}
                    onClick={() => setSelected(row.id)}
                  >
                    <span class="doc-history-title">{versionTitle(row)}</span>
                    <span class="doc-history-meta">
                      {row.kind === "commit" ? `${row.author} · ` : ""}
                      <time dateTime={row.at}>{when(row.at)}</time>
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </nav>
      <div class="doc-history-detail">
        <Show when={error()}>
          {(message) => (
            <p class="doc-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show
          when={version()}
          fallback={
            <div class="doc-empty-state">
              <p>Choose a version to compare it with the document now.</p>
            </div>
          }
        >
          {(row) => (
            <>
              <div class="doc-review-header">
                <h2 class="doc-section-title">{versionTitle(row())} → now</h2>
                <div class="doc-review-header-actions">
                  <button type="button" class="doc-button" onClick={() => void reviewSince()}>
                    Review changes since
                  </button>
                  <button type="button" class="doc-button" onClick={() => setConfirmRestore(true)}>
                    Restore this version
                  </button>
                </div>
              </div>
              <Show
                when={selectedText.latest !== undefined && !selectedText.loading}
                fallback={
                  <p class="doc-muted">
                    {selectedText.error ? errorText(selectedText.error) : "Loading…"}
                  </p>
                }
              >
                <ChangesView
                  kind="compare"
                  label={`Differences between ${versionTitle(row())} and now`}
                  baseline={selectedText.latest ?? ""}
                  current={store.text()}
                />
              </Show>
            </>
          )}
        </Show>
      </div>
      <Show when={confirmRestore() && version()}>
        {(row) => (
          <ConfirmDialog
            title="Restore this version?"
            description={`The document is replaced with “${versionTitle(row())}” from ${when(row().at)}. The current text stays in History.`}
            confirm="Restore"
            onConfirm={() => void restore()}
            onClose={() => setConfirmRestore(false)}
          />
        )}
      </Show>
    </div>
  );
}
