import { createMemo, createSignal, Show } from "solid-js";
import {
  acceptChange,
  type ProseChange,
  proseDiff,
  rejectChange,
} from "../../../shared/prose-diff";
import { ChangesView } from "./ChangesView";
import { ConfirmDialog } from "./Dialog";
import { type DocumentsStore, errorText } from "./documents-store";

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
    if (!current) throw new Error("Open a document first.");
    return { projectId: current.projectId, path: current.path };
  };

  async function step(work: () => Promise<void>) {
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
      if (store.saveState() === "conflict")
        throw new Error("The file changed while you were reviewing it.");
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
            <p>No changes are waiting for review.</p>
            <Show when={store.document()?.committed}>
              <button type="button" class="doc-button" onClick={props.onStartFromCommit}>
                Review changes since the last commit
              </button>
            </Show>
          </div>
        }
      >
        {(current) => (
          <>
            <div class="doc-review-header">
              <h2 class="doc-section-title">
                {current().botId ? `Changes by ${current().botName}` : current().botName}
                <span class="doc-review-total">
                  {" "}
                  · {count() === 1 ? "1 change" : `${count()} changes`}
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
                    Reject all
                  </button>
                  <button
                    type="button"
                    class="doc-button"
                    disabled={busy()}
                    onClick={() => void acceptAll()}
                  >
                    Accept all
                  </button>
                </Show>
                <Show when={count() === 0}>
                  <button
                    type="button"
                    class="doc-button doc-button-primary"
                    disabled={busy()}
                    onClick={() => void finish()}
                  >
                    {current().changedAt ? "Finish review" : "Stop waiting"}
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
                      ? "You've reviewed every change."
                      : `Waiting for ${current().botName} to change the document. Its changes show up here as soon as the file changes.`}
                  </p>
                </div>
              }
            >
              <ChangesView
                kind="review"
                label={`Changes by ${current().botName}`}
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
          title="Reject every change?"
          description="The document goes back to how it was before these changes. The changed text stays in History."
          confirm="Reject all"
          onConfirm={() => void rejectAll()}
          onClose={() => setConfirmReject(false)}
        />
      </Show>
    </div>
  );
}
