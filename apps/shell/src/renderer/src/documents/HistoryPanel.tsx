import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import type { DocumentVersion } from "../../../shared/documents";
import { type MessageKey, t } from "../i18n";
import { ConfirmDialog } from "../kit";
import { ChangesView } from "./ChangesView";
import { type DocumentsStore, errorText } from "./documents-store";

const KIND_LABELS: Record<DocumentVersion["kind"], MessageKey> = {
  saved: "documents.history.kind.saved",
  outside: "documents.history.kind.outside",
  "before-send": "documents.history.kind.beforeSend",
  "before-restore": "documents.history.kind.beforeRestore",
  commit: "documents.history.kind.commit",
};

export function versionTitle(version: DocumentVersion): string {
  if (version.kind === "commit") return version.message || t(KIND_LABELS.commit);
  if (version.kind === "outside")
    return t("documents.history.changedBy", { author: version.author });
  return t(KIND_LABELS[version.kind]);
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
      <nav class="doc-history-list" aria-label={t("documents.history.label")}>
        <Show
          when={(versions.latest ?? []).length > 0}
          fallback={
            <p class="doc-muted">
              {versions.loading ? t("documents.history.loading") : t("documents.history.empty")}
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
        <Show when={version()} fallback={<div class="doc-empty-state" />}>
          {(row) => (
            <>
              <div class="doc-review-header">
                <h2 class="doc-section-title">
                  {t("documents.history.toNow", { title: versionTitle(row()) })}
                </h2>
                <div class="doc-review-header-actions">
                  <button type="button" class="doc-button" onClick={() => void reviewSince()}>
                    {t("documents.history.reviewSince")}
                  </button>
                  <button type="button" class="doc-button" onClick={() => setConfirmRestore(true)}>
                    {t("documents.history.restore")}
                  </button>
                </div>
              </div>
              <Show
                when={selectedText.latest !== undefined && !selectedText.loading}
                fallback={
                  <p class="doc-muted">
                    {selectedText.error ? errorText(selectedText.error) : t("documents.loading")}
                  </p>
                }
              >
                <ChangesView
                  kind="compare"
                  label={t("documents.history.compareLabel", { title: versionTitle(row()) })}
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
            title={t("documents.history.confirmTitle")}
            body={t("documents.history.confirmBody", {
              title: versionTitle(row()),
              date: when(row().at),
            })}
            confirmLabel={t("documents.history.confirm")}
            onConfirm={() => {
              setConfirmRestore(false);
              void restore();
            }}
            onCancel={() => setConfirmRestore(false)}
          />
        )}
      </Show>
    </div>
  );
}
