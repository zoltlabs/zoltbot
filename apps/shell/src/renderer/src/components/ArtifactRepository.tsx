// S2: where the open artifact stands in its project's repository, with Add to repository and,
// for a version held because it may contain a secret, Save anyway after confirming.
// ArtifactPanel keys this by artifact, so nothing here outlives a switch to another artifact.
import { createResource, createSignal, onCleanup, Show } from "solid-js";
import type { ArtifactRepositoryState } from "../../../shared/artifact-repository";
import { t } from "../i18n";
import { ConfirmDialog } from "../kit";
import { memoryError } from "../memory-store";
import "../artifact-share.css";

const LINES: Partial<Record<ArtifactRepositoryState, Parameters<typeof t>[0]>> = {
  written: "repository.written",
  pending: "repository.pending",
  partial: "repository.partial",
  held_secret: "repository.held",
  from_repository: "repository.fromRepository",
};

const lineText = (state: ArtifactRepositoryState) => {
  const key = LINES[state];
  return key ? t(key) : "";
};

export function ArtifactRepository(props: { artifactId: string }) {
  const artifactId = props.artifactId;
  const [view, { refetch, mutate }] = createResource(() =>
    window.openbot.repository.state(artifactId),
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** The version Save anyway was opened for; only that version is ever sent with allowHeld. */
  const [confirming, setConfirming] = createSignal<string | null>(null);
  let line: HTMLOutputElement | undefined;

  // Artifact changes reach the panel as conversation updates.
  const off = window.openbot.agent.onEvent((event) => {
    if (event.type === "conversation" && !busy()) void refetch();
  });
  onCleanup(off);

  async function add(versionId: string, allowHeld: boolean) {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.openbot.repository.add({ artifactId, versionId, allowHeld });
      mutate(next);
      if (allowHeld && next?.state === "held_secret") {
        setError(t("repository.stillHeld"));
        return;
      }
      setConfirming(null);
      setTimeout(() => line?.focus(), 0);
    } catch (failure) {
      setError(memoryError(failure));
    } finally {
      setBusy(false);
    }
  }

  const state = () => view()?.state;
  const canAdd = () => state() === "local" || state() === "pending";

  return (
    <Show when={!view.error && view()}>
      {(current) => (
        <>
          <div class="artifact-repository">
            <output ref={line} class="artifact-repository-state" tabIndex={-1}>
              {lineText(current().state)}
            </output>
            <Show when={canAdd()}>
              <button
                type="button"
                class="zb-kit-button"
                aria-disabled={busy()}
                onClick={() => void add(current().versionId, false)}
              >
                {busy() ? t("repository.adding") : t("repository.add")}
              </button>
            </Show>
            <Show when={state() === "held_secret"}>
              <button
                type="button"
                class="zb-kit-button"
                aria-disabled={busy()}
                onClick={() => !busy() && setConfirming(current().versionId)}
              >
                {t("repository.saveAnyway")}
              </button>
            </Show>
            <Show when={error() && !confirming()}>
              <p class="memory-error" role="alert">
                {error()}
              </p>
            </Show>
          </div>
          <Show when={confirming()}>
            {(versionId) => (
              <ConfirmDialog
                title={t("repository.heldTitle")}
                body={t("repository.heldBody")}
                confirmLabel={t("repository.saveAnyway")}
                busyLabel={t("repository.adding")}
                danger
                busy={busy()}
                error={error()}
                onCancel={() => {
                  setConfirming(null);
                  setError(null);
                }}
                onConfirm={() => void add(versionId(), true)}
              />
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
