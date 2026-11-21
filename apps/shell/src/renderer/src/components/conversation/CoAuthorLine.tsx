// A4: whether agents' commits in this chat's project carry a Co-Authored-By line.
import { createResource, createSignal, createUniqueId, Show } from "solid-js";
import { t } from "../../i18n";
import "./co-author.css";

export function CoAuthorLine(props: { botId: string }) {
  const [project, { mutate }] = createResource(
    () => props.botId,
    (botId) => window.openbot.coAuthor.get(botId),
  );
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const labelId = createUniqueId();
  const noteId = createUniqueId();

  async function toggle() {
    const current = project();
    if (!current || saving()) return;
    const next = { ...current, enabled: !current.enabled };
    setError(null);
    mutate(next);
    setSaving(true);
    try {
      await window.openbot.coAuthor.set(next);
    } catch {
      mutate(current);
      setError(t("repository.coAuthor.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Show when={!project.error && project()}>
      {(current) => (
        <>
          <div class="agent-settings-model-row agent-settings-context-row agent-co-author-row">
            <span id={labelId}>{t("repository.coAuthor.label")}</span>
            <button
              type="button"
              role="switch"
              class="settings-switch"
              classList={{ "settings-switch-on": current().enabled }}
              aria-labelledby={labelId}
              aria-describedby={noteId}
              aria-disabled={saving()}
              aria-checked={current().enabled}
              onClick={() => void toggle()}
            >
              <span />
            </button>
          </div>
          <p id={noteId} class="agent-settings-note">
            {t("repository.coAuthor.note")}
          </p>
          <Show when={error()}>
            <p class="memory-error" role="alert">
              {error()}
            </p>
          </Show>
        </>
      )}
    </Show>
  );
}
