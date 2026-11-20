// S5: one remembered entry on the Memory page. Opens in place to show the text, Edit, Archive
// and its history with Revert to this.
import { createResource, createSignal, For, Show } from "solid-js";
import type { MemoryEntry, MemoryWriter } from "../../../shared/memory";
import { formatDate, t } from "../i18n";
import { ConfirmDialog } from "../kit";
import type { MemoryChange, MemoryStore } from "../memory-store";

export const memoryWhen = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : formatDate(date, { month: "short", day: "numeric" });
};

function writerName(writer: MemoryWriter): string {
  if (writer.kind === "human") return t("memory.writer.you");
  if (writer.kind === "system") return t("memory.writer.app");
  return writer.name || t("memory.writer.agent");
}

export function memoryMeta(
  item: { writer: MemoryWriter; projectId: string | null; projectName: string },
  at: string,
) {
  const project = item.projectId ? item.projectName || t("memory.unknownProject") : "";
  const writer = [writerName(item.writer), project].filter(Boolean).join(" · ");
  return t("memory.entry.meta", { writer, when: memoryWhen(at) });
}

export function MemoryEntryRow(props: {
  entry: MemoryEntry;
  store: MemoryStore;
  open: boolean;
  onToggle: () => void;
  onAnnounce: (text: string) => void;
  /** Called before archiving, so the page can move focus once the row is gone. */
  onRemoving: () => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const regionId = () => `memory-entry-${props.entry.id.replace(/[^\w-]/g, "-")}`;
  // Re-read when the entry gets a new revision.
  const [history] = createResource(
    () => (props.open ? `${props.entry.id}:${props.entry.revision}` : undefined),
    () => props.store.revisions(props.entry.id),
  );
  let toggle: HTMLButtonElement | undefined;
  let titleInput: HTMLInputElement | undefined;
  const errorId = () => `${regionId()}-error`;

  function startEdit() {
    setTitle(props.entry.title);
    setBody(props.entry.body);
    setError(null);
    setEditing(true);
    titleInput?.focus();
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
    toggle?.focus();
  }

  async function run(work: MemoryChange, done: string) {
    setBusy(true);
    const failure = await work();
    setBusy(false);
    setError(failure);
    if (failure) return false;
    props.onAnnounce(done);
    return true;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const next = title().trim();
    const ok = await run(
      () => props.store.save(props.entry, next, body()),
      t("memory.entry.saved", { title: next }),
    );
    if (ok) {
      setEditing(false);
      toggle?.focus();
    }
  }

  return (
    <li class="memory-row" data-entry-id={props.entry.id}>
      <button
        ref={toggle}
        type="button"
        class="memory-row-open"
        aria-expanded={props.open}
        aria-controls={regionId()}
        onClick={props.onToggle}
      >
        <span class="memory-row-title">{props.entry.title}</span>
        <span class="memory-row-meta">{memoryMeta(props.entry, props.entry.updatedAt)}</span>
      </button>
      <Show when={props.open}>
        <div id={regionId()} class="memory-detail">
          <Show
            when={editing()}
            fallback={
              <>
                <p class="memory-body">{props.entry.body}</p>
                <div class="memory-actions">
                  <button type="button" class="zb-kit-button" disabled={busy()} onClick={startEdit}>
                    {t("memory.entry.edit")}
                  </button>
                  <button
                    type="button"
                    class="zb-kit-button"
                    disabled={busy()}
                    onClick={() => {
                      setError(null);
                      setConfirming(true);
                    }}
                  >
                    {t("memory.entry.archive")}
                  </button>
                </div>
              </>
            }
          >
            <form class="memory-edit" onSubmit={save}>
              <label class="memory-field">
                <span>{t("memory.entry.titleLabel")}</span>
                <input
                  ref={titleInput}
                  class="zb-kit-input"
                  aria-invalid={error() ? true : undefined}
                  aria-describedby={error() ? errorId() : undefined}
                  value={title()}
                  maxLength={160}
                  onInput={(event) => setTitle(event.currentTarget.value)}
                />
              </label>
              <label class="memory-field">
                <span>{t("memory.entry.bodyLabel")}</span>
                <textarea
                  class="zb-kit-input"
                  aria-invalid={error() ? true : undefined}
                  aria-describedby={error() ? errorId() : undefined}
                  rows={5}
                  maxLength={1200}
                  value={body()}
                  onInput={(event) => setBody(event.currentTarget.value)}
                />
              </label>
              <div class="memory-actions">
                <button
                  type="submit"
                  class="zb-kit-button primary"
                  disabled={busy() || !title().trim()}
                >
                  {t("memory.entry.save")}
                </button>
                <button type="button" class="zb-kit-button" disabled={busy()} onClick={cancelEdit}>
                  {t("memory.entry.cancel")}
                </button>
              </div>
            </form>
          </Show>
          <Show when={error() && !confirming()}>
            <p id={errorId()} class="memory-error" role="alert">
              {error()}
            </p>
          </Show>
          <section class="memory-history" aria-label={t("memory.entry.history")}>
            <h2>{t("memory.entry.history")}</h2>
            <Show when={!history.loading} fallback={<p>{t("memory.entry.historyLoading")}</p>}>
              <Show when={!history.error} fallback={<p>{t("memory.entry.historyFailed")}</p>}>
                <ol class="memory-revisions">
                  <For each={history()}>
                    {(revision) => (
                      <li class="memory-revision">
                        <div class="memory-revision-head">
                          <span id={`${regionId()}-r${revision.revision}`}>
                            {t("memory.entry.revision", {
                              number: revision.revision,
                              when: memoryWhen(revision.updatedAt),
                            })}
                          </span>
                          <Show
                            when={revision.revision !== props.entry.revision}
                            fallback={
                              <span class="memory-current">{t("memory.entry.current")}</span>
                            }
                          >
                            <button
                              type="button"
                              class="zb-kit-button"
                              disabled={busy() || editing()}
                              aria-describedby={`${regionId()}-r${revision.revision}`}
                              onClick={() =>
                                void run(
                                  () => props.store.revert(props.entry, revision),
                                  t("memory.entry.reverted", {
                                    title: revision.title,
                                    number: revision.revision,
                                  }),
                                )
                              }
                            >
                              {t("memory.entry.revert")}
                            </button>
                          </Show>
                        </div>
                        <p class="memory-revision-title">{revision.title}</p>
                        <p class="memory-revision-body">{revision.body}</p>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </Show>
          </section>
        </div>
      </Show>
      <Show when={confirming()}>
        <ConfirmDialog
          title={t("memory.entry.archiveTitle", { title: props.entry.title })}
          body={t("memory.entry.archiveBody")}
          confirmLabel={t("memory.entry.archiveConfirm")}
          busy={busy()}
          error={error()}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            props.onRemoving();
            void run(
              () => props.store.archive(props.entry),
              t("memory.entry.archived", { title: props.entry.title }),
            ).then((ok) => ok && setConfirming(false));
          }}
        />
      </Show>
    </li>
  );
}
