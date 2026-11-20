import { createSignal, For, Show } from "solid-js";
import type { CommitResult, DocumentFile, DocumentsGit } from "../../../shared/documents";
import { Dialog } from "./Dialog";
import { errorText } from "./documents-store";

const GIT_LABELS: Record<NonNullable<DocumentFile["git"]>, string> = {
  modified: "Modified",
  added: "Added",
  untracked: "New",
  deleted: "Deleted",
  renamed: "Renamed",
};

export const gitLabel = (state: DocumentFile["git"]) => (state ? GIT_LABELS[state] : "");

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
  const [result, setResult] = createSignal<CommitResult | null>(null);

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
      setResult(done);
      props.onDone();
    } catch (failure) {
      setError(errorText(failure));
      props.onDone();
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog
      title={result() ? "Committed" : "Commit changes"}
      onClose={props.onClose}
      class="doc-commit-dialog"
    >
      <Show
        when={result()}
        fallback={
          <form class="doc-dialog-form" onSubmit={(event) => void submit(event)}>
            <fieldset class="doc-fieldset">
              <legend>Changed documents</legend>
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
              <span>Commit message</span>
              <input
                type="text"
                value={message()}
                maxLength={2000}
                onInput={(event) => setMessage(event.currentTarget.value)}
              />
            </label>
            <fieldset class="doc-fieldset">
              <legend>Branch</legend>
              <label class="doc-check">
                <input
                  type="radio"
                  name="doc-branch"
                  checked={!newBranch()}
                  onChange={() => setNewBranch(false)}
                />
                <span>Commit to {props.git.branch ?? "the current commit"}</span>
              </label>
              <label class="doc-check">
                <input
                  type="radio"
                  name="doc-branch"
                  checked={newBranch()}
                  onChange={() => setNewBranch(true)}
                />
                <span>Commit to a new branch</span>
              </label>
              <Show when={newBranch()}>
                <label class="doc-field doc-field-indented">
                  <span>New branch name</span>
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
              <span>Push to the remote after committing</span>
            </label>
            <Show when={error()}>
              {(text) => (
                <p class="doc-error" role="alert">
                  {text()}
                </p>
              )}
            </Show>
            <div class="doc-dialog-actions">
              <button type="button" class="doc-button" onClick={props.onClose}>
                Cancel
              </button>
              <button
                type="submit"
                class="doc-button doc-button-primary"
                disabled={
                  working() ||
                  chosen().size === 0 ||
                  !message().trim() ||
                  (newBranch() && !branch().trim())
                }
              >
                {working()
                  ? push()
                    ? "Committing and pushing…"
                    : "Committing…"
                  : push()
                    ? "Commit and push"
                    : "Commit"}
              </button>
            </div>
          </form>
        }
      >
        {(done) => (
          <div class="doc-dialog-form" role="status">
            <p>
              Committed <code>{done().commit.slice(0, 7)}</code>
              {done().branch ? ` to ${done().branch}` : ""}
              {done().pushed ? " and pushed it." : "."}
            </p>
            <div class="doc-dialog-actions">
              <Show when={done().pullRequestUrl}>
                {(url) => (
                  <button
                    type="button"
                    class="doc-button"
                    onClick={() => void window.openbot.openUrl(url())}
                  >
                    Open a pull request
                  </button>
                )}
              </Show>
              <button
                type="button"
                class="doc-button doc-button-primary"
                autofocus
                onClick={props.onClose}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
