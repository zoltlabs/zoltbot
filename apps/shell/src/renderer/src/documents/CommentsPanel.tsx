import { createMemo, createSignal, For, Show } from "solid-js";
import { locateAnchor } from "../../../shared/document-anchors";
import {
  DOCUMENT_LIMITS,
  type DocumentAnchor,
  type DocumentComment,
} from "../../../shared/documents";
import { type MessageKey, t } from "../i18n";
import { type DocumentsStore, type DocumentWork, errorText } from "./documents-store";

export interface PlacedComment {
  comment: DocumentComment;
  /** Null when the passage isn't in the document anymore. */
  range: { from: number; to: number } | null;
}

/** Comments in the order their passages appear, with ones whose passage is gone at the end. */
export function placeComments(comments: DocumentComment[], text: string): PlacedComment[] {
  return comments
    .map((comment) => ({ comment, range: locateAnchor(text, comment.anchor) }))
    .sort((a, b) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity));
}

const STATE_LABELS: Record<DocumentComment["state"], MessageKey> = {
  draft: "documents.comments.state.draft",
  sent: "documents.comments.state.sent",
  addressed: "documents.comments.state.addressed",
  resolved: "documents.comments.state.resolved",
};

interface CommentsPanelProps {
  store: DocumentsStore;
  placed: PlacedComment[];
  activeId: string | null;
  /** The passage a new comment is being written for, or null. */
  composing: DocumentAnchor | null;
  onCancelCompose: () => void;
  onFocusComment: (placed: PlacedComment) => void;
  onSend: () => void;
}

export function CommentsPanel(props: CommentsPanelProps) {
  const [body, setBody] = createSignal("");
  const [editing, setEditing] = createSignal<string | null>(null);
  const [editBody, setEditBody] = createSignal("");
  const [showResolved, setShowResolved] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const unsent = createMemo(
    () => props.placed.filter((row) => row.comment.state === "draft").length,
  );
  const visible = createMemo(() =>
    props.placed.filter((row) => showResolved() || row.comment.state !== "resolved"),
  );
  const resolved = createMemo(
    () => props.placed.filter((row) => row.comment.state === "resolved").length,
  );

  const run = async (work: DocumentWork) => {
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  async function add(event: SubmitEvent) {
    event.preventDefault();
    const anchor = props.composing;
    const text = body().trim();
    if (!anchor || !text) return;
    await run(async () => {
      await props.store.addComment(anchor, text);
      setBody("");
      props.onCancelCompose();
    });
  }

  return (
    <section class="doc-comments" aria-labelledby="doc-comments-title">
      <div class="doc-comments-header">
        <h2 id="doc-comments-title" class="doc-section-title">
          {t("documents.comments.title")}
        </h2>
        <button
          type="button"
          class="doc-button doc-button-primary"
          disabled={!props.placed.some((row) => row.comment.state !== "resolved")}
          onClick={props.onSend}
        >
          {t("documents.comments.send", { count: unsent() })}
        </button>
      </div>
      <Show when={error()}>
        {(message) => (
          <p class="doc-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={props.composing}>
        {(anchor) => (
          <form class="doc-comment-form" onSubmit={(event) => void add(event)}>
            <blockquote class="doc-comment-quote">{clip(anchor().quote)}</blockquote>
            <label for="doc-new-comment">{t("documents.comments.newLabel")}</label>
            <textarea
              id="doc-new-comment"
              ref={(element) => requestAnimationFrame(() => element.focus())}
              rows={3}
              maxLength={DOCUMENT_LIMITS.comment}
              value={body()}
              placeholder={t("documents.comments.placeholder")}
              onInput={(event) => setBody(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  props.onCancelCompose();
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div class="doc-comment-actions">
              <button type="button" class="doc-button" onClick={props.onCancelCompose}>
                {t("documents.form.cancel")}
              </button>
              <button
                type="submit"
                class="doc-button doc-button-primary"
                aria-keyshortcuts="Meta+Enter"
                disabled={!body().trim()}
              >
                {t("documents.comments.add")}
              </button>
            </div>
          </form>
        )}
      </Show>
      <Show
        when={visible().length > 0}
        fallback={
          <Show when={!props.composing}>
            <p class="doc-muted doc-comments-empty">{t("documents.comments.empty")}</p>
          </Show>
        }
      >
        <ol class="doc-comment-list">
          <For each={visible()}>
            {(row) => (
              <li
                id={`doc-comment-${row.comment.id}`}
                class="doc-comment"
                classList={{ "doc-comment-active": props.activeId === row.comment.id }}
                data-state={row.comment.state}
              >
                <button
                  type="button"
                  class="doc-comment-open"
                  aria-describedby={`doc-comment-state-${row.comment.id}`}
                  disabled={!row.range}
                  onClick={() => props.onFocusComment(row)}
                >
                  <span class="doc-comment-quote">{clip(row.comment.anchor.quote)}</span>
                  <Show when={!row.range}>
                    <span class="doc-comment-gone">{t("documents.comments.gone")}</span>
                  </Show>
                </button>
                <Show
                  when={editing() === row.comment.id}
                  fallback={<p class="doc-comment-body">{row.comment.body}</p>}
                >
                  <form
                    class="doc-comment-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(async () => {
                        await props.store.updateComment(row.comment.id, { body: editBody() });
                        setEditing(null);
                      });
                    }}
                  >
                    <label for={`doc-edit-${row.comment.id}`} class="sr-only">
                      {t("documents.comments.editLabel")}
                    </label>
                    <textarea
                      id={`doc-edit-${row.comment.id}`}
                      ref={(element) => requestAnimationFrame(() => element.focus())}
                      rows={3}
                      maxLength={DOCUMENT_LIMITS.comment}
                      value={editBody()}
                      onInput={(event) => setEditBody(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditing(null);
                        }
                      }}
                    />
                    <div class="doc-comment-actions">
                      <button type="button" class="doc-button" onClick={() => setEditing(null)}>
                        {t("documents.form.cancel")}
                      </button>
                      <button
                        type="submit"
                        class="doc-button doc-button-primary"
                        disabled={!editBody().trim()}
                      >
                        {t("documents.form.save")}
                      </button>
                    </div>
                  </form>
                </Show>
                <div class="doc-comment-footer">
                  <span class="doc-comment-state" id={`doc-comment-state-${row.comment.id}`}>
                    {row.comment.state === "sent" && row.comment.sentTo
                      ? t("documents.comments.sentTo", { name: row.comment.sentTo.name })
                      : t(STATE_LABELS[row.comment.state])}
                  </span>
                  <span class="doc-comment-buttons">
                    <Show when={row.comment.state === "draft" && editing() !== row.comment.id}>
                      <button
                        type="button"
                        class="doc-link-button"
                        onClick={() => {
                          setEditBody(row.comment.body);
                          setEditing(row.comment.id);
                        }}
                      >
                        {t("documents.comments.edit")}
                      </button>
                    </Show>
                    <Show
                      when={row.comment.state === "resolved"}
                      fallback={
                        <button
                          type="button"
                          class="doc-link-button"
                          onClick={() =>
                            void run(() =>
                              props.store.updateComment(row.comment.id, { state: "resolved" }),
                            )
                          }
                        >
                          {t("documents.comments.resolve")}
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="doc-link-button"
                        onClick={() =>
                          void run(() =>
                            props.store.updateComment(row.comment.id, { state: "draft" }),
                          )
                        }
                      >
                        {t("documents.comments.reopen")}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="doc-link-button"
                      aria-label={t("documents.comments.deleteLabel", {
                        quote: clip(row.comment.anchor.quote, 40),
                      })}
                      onClick={() => void run(() => props.store.deleteComment(row.comment.id))}
                    >
                      {t("documents.comments.delete")}
                    </button>
                  </span>
                </div>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={resolved() > 0}>
        <button
          type="button"
          class="doc-link-button doc-comments-toggle"
          aria-pressed={showResolved()}
          onClick={() => setShowResolved(!showResolved())}
        >
          {showResolved()
            ? t("documents.comments.hideResolved")
            : t("documents.comments.showResolved", { count: resolved() })}
        </button>
      </Show>
    </section>
  );
}

function clip(value: string, limit = 140): string {
  const words = value.replace(/\s+/g, " ").trim();
  return words.length > limit ? `${words.slice(0, limit - 1)}…` : words;
}
