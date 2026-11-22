import { createMemo, createSignal, For, Show } from "solid-js";
import type { DocumentFile } from "../../../shared/documents";
import { t } from "../i18n";
import { gitLabel } from "./CommitDialog";
import { errorText } from "./documents-store";

interface DocumentListProps {
  projectName: string;
  files: DocumentFile[];
  truncated: boolean;
  openPath: string | null;
  onOpen: (path: string) => void;
  onCreate(path: string): Promise<void>;
}

/** The project's Markdown files by folder, with what needs attention on each. */
export function DocumentList(props: DocumentListProps) {
  const [query, setQuery] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const folders = createMemo(() => {
    const words = query().trim().toLowerCase();
    const groups = new Map<string, DocumentFile[]>();
    for (const file of props.files) {
      if (words && !file.path.toLowerCase().includes(words)) continue;
      const list = groups.get(file.folder) ?? [];
      list.push(file);
      groups.set(file.folder, list);
    }
    return [...groups].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  });

  async function create(event: SubmitEvent) {
    event.preventDefault();
    let path = name().trim().replace(/^\/+/, "");
    if (!path) return;
    if (!/\.(md|markdown|mdx)$/i.test(path)) path = `${path}.md`;
    setError(null);
    try {
      await props.onCreate(path);
      setCreating(false);
      setName("");
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  return (
    <div class="doc-files-inner">
      <div class="doc-files-tools">
        <label class="doc-search">
          <span class="sr-only">{t("documents.list.filterLabel")}</span>
          <input
            type="search"
            placeholder={t("documents.list.filter")}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          class="doc-button"
          aria-expanded={creating()}
          aria-controls="doc-new-form"
          onClick={() => setCreating(!creating())}
        >
          {t("documents.list.new")}
        </button>
      </div>
      <Show when={creating()}>
        <form id="doc-new-form" class="doc-new-form" onSubmit={(event) => void create(event)}>
          <label for="doc-new-name">{t("documents.list.fileName")}</label>
          <input
            id="doc-new-name"
            ref={(element) => requestAnimationFrame(() => element.focus())}
            type="text"
            placeholder={t("documents.list.example")}
            spellcheck={false}
            value={name()}
            aria-invalid={error() ? "true" : undefined}
            aria-describedby={error() ? "doc-new-error" : undefined}
            onInput={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setCreating(false);
              }
            }}
          />
          <Show when={error()}>
            {(message) => (
              <p id="doc-new-error" class="doc-error">
                {message()}
              </p>
            )}
          </Show>
          <div class="doc-comment-actions">
            <button type="button" class="doc-button" onClick={() => setCreating(false)}>
              {t("documents.form.cancel")}
            </button>
            <button type="submit" class="doc-button doc-button-primary" disabled={!name().trim()}>
              {t("documents.list.create")}
            </button>
          </div>
        </form>
      </Show>
      <Show
        when={folders().length > 0}
        fallback={
          <p class="doc-muted doc-files-empty">
            {props.files.length ? t("documents.list.noMatch") : t("documents.list.empty")}
          </p>
        }
      >
        <For each={folders()}>
          {([folder, files]) => (
            <section class="doc-folder" aria-label={folder || props.projectName}>
              <Show when={folder}>
                <h2 class="doc-folder-name" title={folder}>
                  {folder}
                </h2>
              </Show>
              <ul class="doc-file-list">
                <For each={files}>
                  {(file) => (
                    <li>
                      <button
                        type="button"
                        class="doc-file"
                        aria-current={props.openPath === file.path ? "page" : undefined}
                        title={file.path}
                        onClick={() => props.onOpen(file.path)}
                      >
                        <span class="doc-file-name">{file.name}</span>
                        <Show when={file.reviewing || file.openComments > 0 || file.git}>
                          <span class="doc-file-meta">
                            <Show when={file.reviewing}>
                              <span class="doc-file-review">{t("documents.list.review")}</span>
                            </Show>
                            <Show when={file.openComments > 0}>
                              <span>
                                {t("documents.list.comments", { count: file.openComments })}
                              </span>
                            </Show>
                            <Show when={file.git}>
                              <span
                                classList={{
                                  "doc-file-new": file.git === "untracked" || file.git === "added",
                                }}
                              >
                                {gitLabel(file.git)}
                              </span>
                            </Show>
                          </span>
                        </Show>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </Show>
      <Show when={props.truncated}>
        <p class="doc-muted">{t("documents.list.truncated", { count: 2000 })}</p>
      </Show>
    </div>
  );
}
