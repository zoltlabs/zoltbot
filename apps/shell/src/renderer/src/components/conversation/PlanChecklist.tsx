import { createEffect, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js";
import type { PlanStep } from "../../../../shared/ipc";
import { type MessageKey, t } from "../../i18n";
import { CheckIcon, ChevronIcon } from "./icons";
import { planExpanded, planProgress } from "./plan";
import "./plan.css";

const STATUS_LABEL: Record<PlanStep["status"], MessageKey> = {
  completed: "chat.plan.completed",
  in_progress: "chat.plan.in_progress",
  pending: "chat.plan.pending",
};

/**
 * The agent's plan, pinned under the chat header. It loads the chat's newest plan and follows
 * conversation updates, so it needs only the chat's id.
 */
export function PlanChecklist(props: { botId: string | undefined }) {
  const [steps, setSteps] = createSignal<PlanStep[]>([]);
  const [choice, setChoice] = createSignal<boolean>();
  const listId = createUniqueId();
  const progress = () => planProgress(steps());
  const expanded = () => planExpanded(steps(), choice());

  function load(botId: string) {
    void window.openbot.agent
      .readConversation(botId)
      .then((snapshot) => {
        if (props.botId === botId) setSteps(snapshot.plan ?? []);
      })
      .catch(() => undefined);
  }

  createEffect(
    on(
      () => props.botId,
      (botId) => {
        setChoice(undefined);
        setSteps([]);
        if (botId) load(botId);
      },
    ),
  );

  const stop = window.openbot.agent.onEvent((event) => {
    if (event.type === "conversation" && event.snapshot.botId === props.botId)
      setSteps(event.snapshot.plan ?? []);
    // A read made while the agent was offline had no history; read again once it is ready.
    if (event.type === "status" && event.status.phase === "ready" && props.botId) load(props.botId);
  });
  onCleanup(stop);

  return (
    <Show when={steps().length > 0}>
      <section class="plan-checklist" aria-label={t("chat.plan.title")}>
        <button
          type="button"
          class="plan-checklist-toggle"
          aria-expanded={expanded()}
          aria-controls={listId}
          onClick={() => setChoice(!expanded())}
        >
          <span class="plan-checklist-chevron">
            <ChevronIcon />
          </span>
          <span class="plan-checklist-title">{t("chat.plan.title")}</span>
          <span class="plan-checklist-progress">
            {t("chat.plan.progress", { done: progress().done, total: progress().total })}
          </span>
          <Show when={!expanded() && progress().current}>
            {(current) => (
              <span class="plan-checklist-current" title={current().step}>
                {current().step}
              </span>
            )}
          </Show>
        </button>
        <ol id={listId} class="plan-checklist-steps" hidden={!expanded()}>
          <For each={steps()}>
            {(step) => (
              <li class="plan-step" data-status={step.status}>
                <span class="plan-step-mark" aria-hidden="true">
                  <Show when={step.status === "completed"}>
                    <CheckIcon />
                  </Show>
                </span>
                <span class="plan-step-text">{step.step}</span>
                <span class="sr-only">{t(STATUS_LABEL[step.status])}</span>
              </li>
            )}
          </For>
        </ol>
      </section>
    </Show>
  );
}
