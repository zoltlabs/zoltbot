// S2: when this chat's project writes artifacts into its repository, in the chat's settings.
import { createResource, createSignal, Show } from "solid-js";
import type { ArtifactRepositoryMode } from "../../../../shared/artifact-repository";
import { t } from "../../i18n";
import { Select } from "../../kit";
import { memoryError } from "../../memory-store";

export function RepositoryMode(props: { botId: string }) {
  const [project, { mutate }] = createResource(
    () => props.botId,
    (botId) => window.openbot.repository.mode(botId),
  );
  const [error, setError] = createSignal<string | null>(null);

  async function change(mode: ArtifactRepositoryMode) {
    const current = project();
    if (!current || mode === current.mode) return;
    setError(null);
    mutate({ ...current, mode });
    try {
      await window.openbot.repository.setMode({ projectId: current.projectId, mode });
    } catch (failure) {
      mutate(current);
      setError(memoryError(failure));
    }
  }

  return (
    <Show when={!project.error && project()}>
      {(current) => (
        <>
          <div class="agent-settings-model-row agent-settings-context-row">
            <span aria-hidden="true">{t("repository.mode.label")}</span>
            <Select
              label={t("repository.mode.label")}
              value={current().mode}
              options={[
                { value: "every_save" as const, label: t("repository.mode.everySave") },
                { value: "on_accept" as const, label: t("repository.mode.onAccept") },
                { value: "off" as const, label: t("repository.mode.off") },
              ]}
              onChange={(value) => void change(value)}
            />
          </div>
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
