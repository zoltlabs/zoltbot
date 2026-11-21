// A1: "New agent" opens a gallery of templates plus Start blank. Picking a template shows its
// name, role and instructions to adjust before the agent is created.
import { createResource, createSignal, For, Show } from "solid-js";
import type { AgentTemplateSummary, BotSummary } from "../../../shared/ipc";
import { t } from "../i18n";
import { Dialog, Field, Stack } from "../kit";
import "./new-agent.css";

/** randomUUID needs a secure context; getRandomValues works everywhere. */
function newRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function NewAgentDialog(props: {
  projectId: string | null;
  onStartBlank: () => void;
  onCreated: (bot: BotSummary) => void;
  onClose: () => void;
}) {
  const [templates] = createResource(async () => {
    try {
      return await window.openbot.templates.list();
    } catch {
      // Templates are optional: Start blank still works.
      return [] as AgentTemplateSummary[];
    }
  });
  const [picked, setPicked] = createSignal<AgentTemplateSummary | null>(null);
  let requestId = "";
  let gallery: HTMLUListElement | undefined;
  const [name, setName] = createSignal("");
  const [role, setRole] = createSignal("");
  const [instructions, setInstructions] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const pick = (template: AgentTemplateSummary) => {
    setName(template.name);
    setRole(template.role);
    setInstructions(template.instructions);
    setError(null);
    requestId = newRequestId();
    setPicked(template);
  };

  const back = () => {
    const from = picked()?.id;
    setPicked(null);
    // Focus returns to the card that was picked.
    requestAnimationFrame(() =>
      (gallery?.querySelector(`[data-template="${from}"]`) as HTMLElement | null)?.focus(),
    );
  };

  const create = async () => {
    const template = picked();
    if (!template || !name().trim() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const bot = await window.openbot.templates.create({
        requestId,
        templateId: template.id,
        name: name().trim(),
        role: role().trim(),
        instructions: instructions(),
        projectId: props.projectId,
      });
      props.onCreated(bot);
    } catch {
      setError(t("agent.new.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("agent.new.title")}
      width={640}
      busy={busy()}
      onClose={props.onClose}
      initialFocus=".new-agent-card"
      actions={
        <Show
          when={picked()}
          fallback={
            <button type="button" class="zb-kit-button zb-kit-cancel" onClick={props.onClose}>
              {t("agent.new.cancel")}
            </button>
          }
        >
          <button
            type="button"
            class="zb-kit-button"
            disabled={busy()}
            onClick={back}
          >
            {t("agent.new.back")}
          </button>
          <button
            type="button"
            class="zb-kit-button primary"
            disabled={busy() || !name().trim()}
            aria-busy={busy() || undefined}
            onClick={() => void create()}
          >
            {busy() ? t("agent.new.creating") : t("agent.new.create")}
          </button>
        </Show>
      }
    >
      <Show
        when={picked()}
        fallback={
          <ul
            ref={gallery}
            class="new-agent-grid"
            aria-label={t("agent.new.templates")}
            aria-busy={templates.loading || undefined}
          >
            <li>
              <button type="button" class="new-agent-card" onClick={() => props.onStartBlank()}>
                <span class="new-agent-card-name">{t("agent.new.blank")}</span>
              </button>
            </li>
            <For each={templates() ?? []}>
              {(template) => (
                <li>
                  <button
                    type="button"
                    class="new-agent-card"
                    data-template={template.id}
                    onClick={() => pick(template)}
                  >
                    <span class="new-agent-card-name">{template.name}</span>
                    <span class="new-agent-card-role">{template.role}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Stack gap={3}>
            <Field
              label={t("agent.new.name")}
              input={(id) => (
                <input
                  id={id}
                  ref={(element) => requestAnimationFrame(() => element.focus())}
                  class="zb-kit-input"
                  value={name()}
                  maxLength={150}
                  onInput={(event) => setName(event.currentTarget.value)}
                />
              )}
            />
            <Field
              label={t("agent.new.role")}
              input={(id) => (
                <input
                  id={id}
                  class="zb-kit-input"
                  value={role()}
                  maxLength={300}
                  onInput={(event) => setRole(event.currentTarget.value)}
                />
              )}
            />
            <Field
              label={t("agent.new.instructions")}
              input={(id) => (
                <textarea
                  id={id}
                  class="zb-kit-input new-agent-instructions"
                  rows={8}
                  maxLength={4000}
                  value={instructions()}
                  onInput={(event) => setInstructions(event.currentTarget.value)}
                />
              )}
            />
            <Show when={error()}>
              <p class="zb-kit-error" role="alert">
                {error()}
              </p>
            </Show>
          </Stack>
        </form>
      </Show>
    </Dialog>
  );
}
