import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { anchorFor } from "../../../shared/document-anchors";
import type { DocumentAnchor } from "../../../shared/documents";
import { proseDiff } from "../../../shared/prose-diff";
import type { BotProfile } from "../data";
import { type MessageKey, t } from "../i18n";
import { ConfirmDialog, showToast } from "../kit";
import { CommentsPanel, type PlacedComment, placeComments } from "./CommentsPanel";
import {
  type DocumentMode,
  type DocumentsStore,
  errorText,
  type SaveState,
} from "./documents-store";
import { wordCount } from "./editor-setup";
import { HistoryPanel } from "./HistoryPanel";
import { type EditorHandle, type FormatAction, MarkdownEditor } from "./MarkdownEditor";
import { MarkdownPreview } from "./MarkdownPreview";
import { ReviewPanel } from "./ReviewPanel";
import { SendDialog } from "./SendDialog";

const MODES: { id: DocumentMode; label: MessageKey }[] = [
  { id: "write", label: "documents.tab.write" },
  { id: "preview", label: "documents.tab.preview" },
  { id: "review", label: "documents.tab.review" },
  { id: "history", label: "documents.tab.history" },
];

/** Each button shows `text`, or its label when it has none. */
const FORMATS: { action: FormatAction; label: MessageKey; text?: string; keys?: string }[] = [
  { action: "heading", label: "documents.format.heading", text: "H" },
  { action: "bold", label: "documents.format.bold", text: "B", keys: "Meta+B" },
  { action: "italic", label: "documents.format.italic", text: "I", keys: "Meta+I" },
  { action: "quote", label: "documents.format.quote", text: "“”" },
  { action: "list", label: "documents.format.list", text: "•" },
  { action: "link", label: "documents.format.link", keys: "Meta+K" },
];

const SAVE_LABELS: Record<SaveState, MessageKey> = {
  saved: "documents.saveState.saved",
  unsaved: "documents.saveState.unsaved",
  saving: "documents.saveState.saving",
  conflict: "documents.saveState.notSaved",
  error: "documents.saveState.notSaved",
};

interface DocumentPaneProps {
  store: DocumentsStore;
  bots: BotProfile[];
  /** Opens Tasks, where the agent's document task runs. */
  onOpenTasks: () => void;
}

/** The open document: write, preview, review an agent's changes, or look through history. */
export function DocumentPane(props: DocumentPaneProps) {
  const store = props.store;
  let editor: EditorHandle | undefined;
  const [selection, setSelection] = createSignal({ from: 0, to: 0 });
  const [composing, setComposing] = createSignal<DocumentAnchor | null>(null);
  const [activeComment, setActiveComment] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  const [confirmUseFile, setConfirmUseFile] = createSignal(false);
  const [reviewError, setReviewError] = createSignal<string | null>(null);
  const [scrolled, setScrolled] = createSignal(0);
  /** Where the floating Comment button sits: just below the end of the selection. */
  const floatAt = createMemo(() => {
    scrolled();
    const range = selection();
    if (range.to <= range.from) return null;
    const point = editor?.coordsAt(range.to);
    return point ? { top: point.bottom + 6, left: Math.max(8, point.left - 40) } : null;
  });
  const doc = () => store.document();
  const placed = createMemo<PlacedComment[]>(() =>
    placeComments(doc()?.comments ?? [], store.text()),
  );
  const ranges = createMemo(() =>
    placed()
      .filter((row) => row.range && row.comment.state !== "resolved")
      .map((row) => ({ id: row.comment.id, from: row.range?.from ?? 0, to: row.range?.to ?? 0 })),
  );
  const pending = createMemo(() => {
    const baseline = doc()?.baseline;
    return baseline == null ? 0 : proseDiff(baseline, store.text()).changes.length;
  });
  const words = createMemo(() => wordCount(store.text()));
  const hasSelection = () => selection().to > selection().from && store.mode() === "write";
  const defaultBot = () => {
    const sent = [...(doc()?.comments ?? [])].reverse().find((comment) => comment.sentTo)
      ?.sentTo?.botId;
    return (
      sent ??
      doc()?.review?.botId ??
      props.bots.find((bot) => bot.companyRole === "ceo")?.id ??
      props.bots[0]?.id ??
      null
    );
  };

  // A different document starts without a comment in progress.
  createEffect(
    on(
      () => doc()?.path,
      () => {
        setComposing(null);
        setActiveComment(null);
      },
      { defer: true },
    ),
  );

  function startComment() {
    const range = selection();
    if (store.mode() !== "write") store.setMode("write");
    if (range.to <= range.from) return;
    setComposing(anchorFor(store.text(), range.from, range.to));
  }

  function focusComment(row: PlacedComment) {
    setActiveComment(row.comment.id);
    if (row.range) {
      if (store.mode() !== "write") store.setMode("write");
      requestAnimationFrame(() => editor?.select(row.range?.from ?? 0, row.range?.to ?? 0));
    }
  }

  function onTabKey(event: KeyboardEvent, index: number) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const target = event.key === "Home" ? 0 : event.key === "End" ? MODES.length - 1 : index + step;
    if (!step && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = MODES[(target + MODES.length) % MODES.length];
    store.setMode(next.id);
    document.getElementById(`doc-tab-${next.id}`)?.focus();
  }

  async function startReviewFromCommit() {
    const current = doc();
    if (!current) return;
    setReviewError(null);
    try {
      await store.flush();
      store.load(
        await window.openbot.documents.startReview({
          projectId: current.projectId,
          path: current.path,
          versionId: "head",
        }),
      );
    } catch (failure) {
      setReviewError(errorText(failure));
    }
  }

  return (
    <Show when={doc()}>
      {(current) => (
        <div class="doc-pane">
          <div class="doc-toolbar">
            <div class="doc-title-row">
              <h2 class="doc-title" title={current().path}>
                {current().path}
              </h2>
              <output
                class="doc-save-state"
                data-state={store.saveState()}
                aria-live={
                  store.saveState() === "error" || store.saveState() === "conflict"
                    ? "assertive"
                    : "off"
                }
              >
                {t(SAVE_LABELS[store.saveState()])}
              </output>
            </div>
            <div class="doc-toolbar-row">
              <div class="doc-tabs" role="tablist" aria-label={t("documents.tabs.label")}>
                <For each={MODES}>
                  {(mode, index) => (
                    <button
                      type="button"
                      role="tab"
                      id={`doc-tab-${mode.id}`}
                      class="doc-tab"
                      aria-selected={store.mode() === mode.id}
                      aria-controls="doc-tabpanel"
                      tabIndex={store.mode() === mode.id ? 0 : -1}
                      onClick={() => store.setMode(mode.id)}
                      onKeyDown={(event) => onTabKey(event, index())}
                    >
                      {t(mode.label)}
                      <Show when={mode.id === "review" && pending() > 0}>
                        <span class="doc-tab-count">
                          {pending()}
                          <span class="sr-only">
                            {t("documents.tab.changes", { count: pending() })}
                          </span>
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
              <Show when={store.mode() === "write"}>
                <div class="doc-format" role="toolbar" aria-label={t("documents.format.label")}>
                  <For each={FORMATS}>
                    {(format) => (
                      <button
                        type="button"
                        class="doc-icon-button"
                        classList={{ [`doc-format-${format.action}`]: true }}
                        aria-label={t(format.label)}
                        title={
                          format.keys
                            ? t("documents.format.withKeys", {
                                label: t(format.label),
                                keys: format.keys.replace("Meta", "⌘"),
                              })
                            : t(format.label)
                        }
                        aria-keyshortcuts={format.keys}
                        onClick={() => editor?.format(format.action)}
                      >
                        {format.text ?? t(format.label)}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={store.mode() === "write"}>
                <button
                  type="button"
                  class="doc-button doc-comment-button"
                  aria-keyshortcuts="Meta+Alt+M"
                  title={t("documents.comment.title")}
                  disabled={!hasSelection()}
                  onClick={startComment}
                >
                  {t("documents.comment.button")}
                </button>
              </Show>
            </div>
          </div>

          <Show when={store.saveState() === "conflict"}>
            <div class="doc-banner doc-banner-warning" role="alert">
              <p>{t("documents.conflict.body")}</p>
              <div class="doc-banner-actions">
                <button type="button" class="doc-button" onClick={() => setConfirmUseFile(true)}>
                  {t("documents.conflict.useFile")}
                </button>
                <button
                  type="button"
                  class="doc-button doc-button-primary"
                  onClick={() => void store.keepMine()}
                >
                  {t("documents.conflict.keepMine")}
                </button>
              </div>
            </div>
          </Show>
          <Show when={store.saveError()}>
            {(message) => (
              <div class="doc-banner doc-banner-warning" role="alert">
                <p>{t("documents.saveError", { message: message() })}</p>
                <div class="doc-banner-actions">
                  <button type="button" class="doc-button" onClick={() => void store.save(true)}>
                    {t("documents.tryAgain")}
                  </button>
                </div>
              </div>
            )}
          </Show>
          <Show when={store.externalChange() && store.mode() !== "review" && pending() > 0}>
            <div class="doc-banner" role="status">
              <p>
                {t("documents.external.body", {
                  name: store.externalChange() ?? "",
                  count: pending(),
                })}
              </p>
              <div class="doc-banner-actions">
                <button
                  type="button"
                  class="doc-button doc-button-primary"
                  onClick={() => {
                    store.clearExternalChange();
                    store.setMode("review");
                  }}
                >
                  {t("documents.external.review")}
                </button>
              </div>
            </div>
          </Show>
          <Show when={reviewError()}>
            {(message) => (
              <p class="doc-error" role="alert">
                {message()}
              </p>
            )}
          </Show>

          <div
            class="doc-workspace"
            classList={{
              "doc-workspace-wide": store.mode() === "review" || store.mode() === "history",
            }}
          >
            <div
              id="doc-tabpanel"
              class="doc-tabpanel"
              role="tabpanel"
              aria-labelledby={`doc-tab-${store.mode()}`}
            >
              <div class="doc-editor-wrap" hidden={store.mode() !== "write"}>
                <MarkdownEditor
                  text={store.text()}
                  loadCount={store.loadCount()}
                  comments={ranges()}
                  activeComment={activeComment()}
                  onChange={store.edit}
                  onSelection={(from, to) => setSelection({ from, to })}
                  onCommentClick={(id) => {
                    setActiveComment(id);
                    document
                      .getElementById(`doc-comment-${id}`)
                      ?.scrollIntoView({ block: "nearest" });
                  }}
                  onSave={() => void store.save(true)}
                  onComment={startComment}
                  onScroll={() => setScrolled((count) => count + 1)}
                  ref={(handle) => {
                    editor = handle;
                  }}
                />
                <Show when={hasSelection() && !composing() && floatAt()}>
                  {(point) => (
                    <button
                      type="button"
                      class="doc-float-comment"
                      tabIndex={-1}
                      style={{ top: `${point().top}px`, left: `${point().left}px` }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={startComment}
                    >
                      {t("documents.comment.button")}
                    </button>
                  )}
                </Show>
              </div>
              <Show when={store.mode() === "preview"}>
                <MarkdownPreview
                  text={store.text()}
                  label={t("documents.preview.label", { path: current().path })}
                />
              </Show>
              <Show when={store.mode() === "review"}>
                <ReviewPanel store={store} onStartFromCommit={() => void startReviewFromCommit()} />
              </Show>
              <Show when={store.mode() === "history"}>
                <HistoryPanel store={store} />
              </Show>
            </div>
            <Show when={store.mode() === "write" || store.mode() === "preview"}>
              <CommentsPanel
                store={store}
                placed={placed()}
                activeId={activeComment()}
                composing={composing()}
                onCancelCompose={() => {
                  setComposing(null);
                  editor?.focus();
                }}
                onFocusComment={focusComment}
                onSend={() => setSending(true)}
              />
            </Show>
          </div>
          <footer class="doc-status">
            <span>{t("documents.status.words", { count: words() })}</span>
          </footer>

          <Show when={sending()}>
            <SendDialog
              path={current().path}
              comments={placed()}
              bots={props.bots}
              defaultBotId={defaultBot()}
              onSend={async (botId, ids, note) => {
                await store.sendComments(botId, ids, note);
                const name = props.bots.find((bot) => bot.id === botId)?.name;
                showToast({
                  message: name
                    ? t("documents.send.sentTo", { name })
                    : t("documents.send.sentToAgent"),
                  action: { label: t("documents.send.openTasks"), run: props.onOpenTasks },
                });
              }}
              onClose={() => setSending(false)}
            />
          </Show>
          <Show when={confirmUseFile()}>
            <ConfirmDialog
              title={t("documents.useFile.title")}
              body={t("documents.useFile.body")}
              confirmLabel={t("documents.useFile.confirm")}
              danger
              onConfirm={() => {
                setConfirmUseFile(false);
                void store.useFile();
              }}
              onCancel={() => setConfirmUseFile(false)}
            />
          </Show>
        </div>
      )}
    </Show>
  );
}
