import { createEffect, createMemo, createSignal, on, onMount, Show } from "solid-js";
import { SidebarToggleIcon } from "../components/SidebarIcons";
import type { BotProfile } from "../data";
import { t } from "../i18n";
import { CommitDialog } from "./CommitDialog";
import { DocumentList } from "./DocumentList";
import { DocumentPane } from "./DocumentPane";
import { createDocumentsStore, errorText } from "./documents-store";

interface DocumentsPageProps {
  projectId: string;
  /** A file to open first, such as one an artifact was just saved to. */
  openPath: string | null;
  bots: BotProfile[];
  sidebarCollapsed: boolean;
  onShowSidebar: () => void;
  onOpenTasks: (projectId: string) => void;
}

/**
 * A project's Markdown documents: a list of files, the editor, comments for agents, reviewing
 * what agents changed, history, and committing the result to git.
 */
export function DocumentsPage(props: DocumentsPageProps) {
  const store = createDocumentsStore(() => props.projectId);
  const [committing, setCommitting] = createSignal(false);
  const [pushing, setPushing] = createSignal(false);
  const [gitError, setGitError] = createSignal<string | null>(null);
  const [filesOpen, setFilesOpen] = createSignal(true);
  let heading: HTMLHeadingElement | undefined;
  const projectBots = createMemo(() =>
    props.bots.filter((bot) => bot.projectId === props.projectId),
  );
  const overview = () => store.overview();
  const git = () => overview()?.git ?? null;

  onMount(() => heading?.focus());
  createEffect(
    on(
      () => props.projectId,
      () => {
        store.close();
        void store.refreshList().then(() => {
          if (props.openPath) void store.open(props.openPath);
        });
      },
    ),
  );
  createEffect(
    on(
      () => props.openPath,
      (path) => {
        if (path && store.overview()) void store.open(path);
      },
      { defer: true },
    ),
  );
  // Saving changes git's view of the file, so the list's badges follow.
  createEffect(
    on(
      () => store.document()?.hash,
      () => void store.refreshList(),
      { defer: true },
    ),
  );

  async function push() {
    setPushing(true);
    setGitError(null);
    try {
      await window.openbot.documents.push(props.projectId);
    } catch (failure) {
      setGitError(errorText(failure));
    } finally {
      setPushing(false);
      void store.refreshList();
    }
  }

  return (
    <main aria-label={t("documents.title")} class="map-panel docs-panel">
      <header class="window-drag map-header docs-header">
        <Show when={props.sidebarCollapsed}>
          <button
            type="button"
            class="sidebar-icon-button sidebar-restore-button no-drag"
            aria-label={t("documents.showSidebar")}
            aria-controls="bot-sidebar"
            aria-expanded="false"
            title={t("documents.showSidebar")}
            onClick={props.onShowSidebar}
          >
            <SidebarToggleIcon />
          </button>
        </Show>
        <h1 ref={heading} class="map-title docs-title" tabIndex={-1}>
          {t("documents.title")}
        </h1>
        <Show when={git()}>
          {(state) => (
            <div class="docs-git no-drag">
              <span class="docs-branch" title={t("documents.git.branchTitle")}>
                <span class="sr-only">{t("documents.git.branchLabel")}</span>
                {state().branch ?? t("documents.git.detached")}
              </span>
              <Show when={state().ahead > 0}>
                <button
                  type="button"
                  class="doc-button"
                  disabled={pushing()}
                  onClick={() => void push()}
                >
                  {pushing()
                    ? t("documents.git.pushing")
                    : t("documents.git.push", { count: state().ahead })}
                </button>
              </Show>
              <Show when={state().pullRequestUrl && state().ahead === 0 && state().upstream}>
                <button
                  type="button"
                  class="doc-button"
                  onClick={() => void window.openbot.openUrl(state().pullRequestUrl ?? "")}
                >
                  {t("documents.openPullRequest")}
                </button>
              </Show>
              <button
                type="button"
                class="doc-button doc-button-primary"
                disabled={state().changed === 0}
                onClick={async () => {
                  await store.flush();
                  await store.refreshList();
                  setCommitting(true);
                }}
              >
                {t("documents.git.commit", { count: state().changed })}
              </button>
            </div>
          )}
        </Show>
      </header>
      <Show when={gitError() || store.listError()}>
        {(message) => (
          <p class="doc-error docs-page-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show
        when={overview()}
        fallback={
          <div class="docs-loading" role="status">
            {store.listError() ? "" : t("documents.page.loading")}
          </div>
        }
      >
        {(current) => (
          <Show
            when={current().root}
            fallback={
              <div class="doc-empty-state docs-empty">
                <p>{t("documents.page.noFolder")}</p>
              </div>
            }
          >
            <div class="docs-body" classList={{ "docs-files-hidden": !filesOpen() }}>
              <nav
                class="docs-files"
                aria-label={t("documents.files.label", { project: current().projectName })}
              >
                <button
                  type="button"
                  class="doc-link-button docs-files-toggle"
                  aria-expanded={filesOpen()}
                  aria-controls="docs-file-list"
                  onClick={() => setFilesOpen(!filesOpen())}
                >
                  {filesOpen() ? t("documents.files.hide") : t("documents.files.show")}
                </button>
                <div id="docs-file-list" hidden={!filesOpen()}>
                  <DocumentList
                    projectName={current().projectName}
                    files={current().files}
                    truncated={current().truncated}
                    openPath={store.document()?.path ?? store.opening()}
                    onOpen={(path) => void store.open(path)}
                    onCreate={(path) => store.create(path)}
                  />
                </div>
              </nav>
              <section class="docs-main" aria-label={t("documents.editor.label")}>
                <Show when={store.openError()}>
                  {(message) => (
                    <p class="doc-error" role="alert">
                      {message()}
                    </p>
                  )}
                </Show>
                <Show
                  when={store.document()}
                  fallback={
                    <div class="doc-empty-state docs-empty">
                      <p>
                        {store.opening()
                          ? t("documents.page.opening")
                          : current().files.length
                            ? t("documents.page.choose")
                            : t("documents.page.create")}
                      </p>
                    </div>
                  }
                >
                  <DocumentPane store={store} bots={projectBots()} onOpenTasks={() => props.onOpenTasks(props.projectId)} />
                </Show>
              </section>
            </div>
            <Show when={committing() && current().git}>
              {(state) => (
                <CommitDialog
                  projectId={props.projectId}
                  files={current().files}
                  git={state()}
                  current={store.document()?.path ?? null}
                  onDone={() => {
                    void store.refreshList();
                    const open = store.document();
                    if (open) void store.open(open.path);
                  }}
                  onClose={() => setCommitting(false)}
                />
              )}
            </Show>
          </Show>
        )}
      </Show>
    </main>
  );
}
