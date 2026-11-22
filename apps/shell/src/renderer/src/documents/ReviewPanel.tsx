import { createMemo, createSignal, Show } from "solid-js";
import {
  acceptChange,
  type ProseChange,
  proseDiff,
  rejectChange,
} from "../../../shared/prose-diff";
import { t } from "../i18n";
import { ConfirmDialog } from "../kit";
import { ChangesView } from "./ChangesView";
import { type DocumentsStore, type DocumentWork, errorText } from "./documents-store";

/**
 * Reviewing an agent's changes. Accepting a change moves the review's baseline to the new words;
 * rejecting one puts the old words back in the file. When no changes are left, the review ends.
 */
export function ReviewPanel(props: { store: DocumentsStore; onStartFromCommit: () => void }) {
  const store = props.store;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [confirmReject, setConfirmReject] = createSignal(false);
  const review = () => store.document()?.review ?? null;
  const baseline = () => store.document()?.baseline ?? null;
  const count = createMemo(() => {
    const base = baseline();
    return base === null ? 0 : proseDiff(base, store.text()).changes.length;
  });

  const ref = () => {
    const current = store.document();
    if (!current) throw new Error(t("documents.openFirst"));
    return { projectId: current.projectId, path: current.path };
  };

  async function step(work: DocumentWork) {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await store.flush();
      await work();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  const setBaseline = async (text: string) =>
    store.load(await window.openbot.documents.setBaseline({ ...ref(), text }));

  const accept = (change: ProseChange) =>
    step(async () => {
      const base = baseline();
      if (base !== null) await setBaseline(acceptChange(base, change));
    });
  const reject = (change: ProseChange) =>
    step(async () => {
      await store.replace(rejectChange(store.text(), change));
      if (store.saveState() === "conflict") throw new Error(t("documents.review.fileChanged"));
    });
  const acceptAll = () => step(() => setBaseline(store.text()));
  const rejectAll = () =>
    step(async () => {
      const base = baseline();
      if (base !== null) await store.replace(base);
    });
  const finish = () =>
    step(async () => store.load(await window.openbot.documents.endReview(ref())));

  return (
    <div class="doc-review">
      <Show
        when={review()}
        fallback={
          <div class="doc-empty-state">
            <p>{t("documents.review.none")}</p>
            <Show when={store.document()?.committed}>
              <button type="button" class="doc-button" onClick={props.onStartFromCommit}>
                {t("documents.review.sinceCommit")}
              </button>
            </Show>
          </div>
        }
      >
        {(current) => (
          <>
            <div class="doc-review-header">
              <h2 class="doc-section-title">
                {current().botId
                  ? t("documents.review.changesBy", { name: current().botName })
                  : current().botName}
                <span class="doc-review-total">
                  {" "}
                  {t("documents.review.total", { count: count() })}
                </span>
              </h2>
              <div class="doc-review-header-actions">
                <Show when={count() > 0}>
                  <button
                    type="button"
                    class="doc-button"
                    disabled={busy()}
                    onClick={() => setConfirmReject(true)}
                  >
                    {t("documents.review.rejectAll")}
                  </button>
                  <button
                    type="button"
                    class="doc-button"
                    disabled={busy()}
                    onClick={() => void acceptAll()}
                  >
                    {t("documents.review.acceptAll")}
                  </button>
                </Show>
                <Show when={count() === 0}>
                  <button
                    type="button"
                    class="doc-button doc-button-primary"
                    disabled={busy()}
                    onClick={() => void finish()}
                  >
                    {current().changedAt
                      ? t("documents.review.finish")
                      : t("documents.review.stopWaiting")}
                  </button>
                </Show>
              </div>
            </div>
            <Show when={error()}>
              {(message) => (
                <p class="doc-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <Show
              when={count() > 0}
              fallback={
                <div class="doc-empty-state" role="status">
                  <p>
                    {current().changedAt
                      ? t("documents.review.done")
                      : t("documents.review.waiting", { name: current().botName })}
                  </p>
                </div>
              }
            >
              <ChangesView
                kind="review"
                label={t("documents.review.changesBy", { name: current().botName })}
                baseline={baseline() ?? ""}
                current={store.text()}
                busy={busy()}
                onAccept={(change) => void accept(change)}
                onReject={(change) => void reject(change)}
              />
            </Show>
          </>
        )}
      </Show>
      <Show when={confirmReject()}>
        <ConfirmDialog
          title={t("documents.review.confirmTitle")}
          body={t("documents.review.confirmBody")}
          confirmLabel={t("documents.review.rejectAll")}
          danger
          onConfirm={() => {
            setConfirmReject(false);
            void rejectAll();
          }}
          onCancel={() => setConfirmReject(false)}
        />
      </Show>
    </div>
  );
}
