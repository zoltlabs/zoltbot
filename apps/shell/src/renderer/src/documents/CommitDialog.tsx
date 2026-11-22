import { createSignal, createUniqueId, For, Show } from "solid-js";
import type { CommitResult, DocumentFile, DocumentsGit } from "../../../shared/documents";
import { type MessageKey, t } from "../i18n";
import { Dialog, showToast } from "../kit";
import { errorText } from "./documents-store";

const GIT_LABELS: Record<NonNullable<DocumentFile["git"]>, MessageKey> = {
  modified: "documents.git.modified",
  added: "documents.git.added",
  untracked: "documents.git.untracked",
  deleted: "documents.git.deleted",
  renamed: "documents.git.renamed",
};

export const gitLabel = (state: DocumentFile["git"]) => (state ? t(GIT_LABELS[state]) : "");

interface CommitDialogProps {
  projectId: string;
  files: DocumentFile[];
  git: DocumentsGit;
  /** The file to mention in the default message. */
  current: string | null;
  onDone: () => void;
  onClose: () => void;
}

/** Commits changed documents, on this branch or a new one, and pushes them if asked. */
export function CommitDialog(props: CommitDialogProps) {
  const changed = () => props.files.filter((file) => file.git);
  const [chosen, setChosen] = createSignal(new Set(changed().map((file) => file.path)));
  const defaultMessage = () => {
    const only =
      changed().length === 1
        ? changed()[0]
        : props.files.find((file) => file.path === props.current && file.git);
    return changed().length === 1 && only
      ? `Update ${only.name.replace(/\.(md|markdown|mdx)$/i, "")}`
      : `Update ${changed().length} documents`;
  };
  const [message, setMessage] = createSignal(defaultMessage());
  const onDefault = () =>
    !props.git.branch || props.git.branch === (props.git.defaultBranch ?? "main");
  const [newBranch, setNewBranch] = createSignal(onDefault());
  const [branch, setBranch] = createSignal(`draft-${new Date().toISOString().slice(0, 10)}`);
  const [push, setPush] = createSignal(true);
  const [working, setWorking] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const formId = createUniqueId();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      const done = await window.openbot.documents.commit({
        projectId: props.projectId,
        paths: [...chosen()],
        message: message().trim(),
        branch: newBranch() ? branch().trim() : null,
        push: push(),
      });
      props.onDone();
      showToast(committedToast(done));
      props.onClose();
    } catch (failure) {
      setError(errorText(failure));
      props.onDone();
    } finally {
      setWorking(false);
    }
  }

  const ready = () =>
    !working() && chosen().size > 0 && !!message().trim() && (!newBranch() || !!branch().trim());

  return (
    <Dialog
      title={t("documents.commit.title")}
      onClose={props.onClose}
      busy={working()}
      width={460}
      actions={
        <>
          <button type="button" class="zb-kit-button" onClick={props.onClose}>
            {t("documents.form.cancel")}
          </button>
          <button type="submit" form={formId} class="zb-kit-button primary" disabled={!ready()}>
            {working()
              ? push()
                ? t("documents.commit.committingPushing")
                : t("documents.commit.committing")
              : push()
                ? t("documents.commit.commitPush")
                : t("documents.commit.commit")}
          </button>
        </>
      }
    >
      <form id={formId} class="doc-dialog-form" onSubmit={(event) => void submit(event)}>
        <fieldset class="doc-fieldset">
          <legend>{t("documents.commit.changed")}</legend>
          <ul class="doc-send-list">
            <For each={changed()}>
              {(file) => (
                <li>
                  <label class="doc-check">
                    <input
                      type="checkbox"
                      checked={chosen().has(file.path)}
                      onChange={(event) => {
                        const next = new Set(chosen());
                        if (event.currentTarget.checked) next.add(file.path);
                        else next.delete(file.path);
                        setChosen(next);
                      }}
                    />
                    <span>
                      <span class="doc-commit-path">{file.path}</span>
                      <span class="doc-send-state">{gitLabel(file.git)}</span>
                    </span>
                  </label>
                </li>
              )}
            </For>
          </ul>
        </fieldset>
        <label class="doc-field">
          <span>{t("documents.commit.message")}</span>
          <input
            type="text"
            value={message()}
            maxLength={2000}
            onInput={(event) => setMessage(event.currentTarget.value)}
          />
        </label>
        <fieldset class="doc-fieldset">
          <legend>{t("documents.commit.branch")}</legend>
          <label class="doc-check">
            <input
              type="radio"
              name="doc-branch"
              checked={!newBranch()}
              onChange={() => setNewBranch(false)}
            />
            <span>
              {props.git.branch
                ? t("documents.commit.toBranch", { branch: props.git.branch })
                : t("documents.commit.toCurrent")}
            </span>
          </label>
          <label class="doc-check">
            <input
              type="radio"
              name="doc-branch"
              checked={newBranch()}
              onChange={() => setNewBranch(true)}
            />
            <span>{t("documents.commit.newBranch")}</span>
          </label>
          <Show when={newBranch()}>
            <label class="doc-field doc-field-indented">
              <span>{t("documents.commit.newBranchName")}</span>
              <input
                type="text"
                value={branch()}
                maxLength={200}
                spellcheck={false}
                onInput={(event) => setBranch(event.currentTarget.value)}
              />
            </label>
          </Show>
        </fieldset>
        <label class="doc-check">
          <input
            type="checkbox"
            checked={push()}
            onChange={(event) => setPush(event.currentTarget.checked)}
          />
          <span>{t("documents.commit.push")}</span>
        </label>
        <Show when={error()}>
          {(text) => (
            <p class="doc-error" role="alert">
              {text()}
            </p>
          )}
        </Show>
      </form>
    </Dialog>
  );
}

function committedToast(done: CommitResult) {
  const sha = done.commit.slice(0, 7);
  const branch = done.branch;
  const url = done.pullRequestUrl;
  const message = branch
    ? done.pushed
      ? t("documents.commit.doneBranchPushed", { sha, branch })
      : t("documents.commit.doneBranch", { sha, branch })
    : done.pushed
      ? t("documents.commit.donePushed", { sha })
      : t("documents.commit.done", { sha });
  return {
    message,
    ...(url
      ? {
          action: {
            label: t("documents.openPullRequest"),
            run: () => void window.openbot.openUrl(url),
          },
        }
      : {}),
  };
}
