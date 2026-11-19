import { createSignal, createUniqueId } from "solid-js";
import type { AgentPromptQuestion } from "../../../shared/ipc";
import type { ModelSwitchDialog } from "../../../shared/models";
import type { BotMessage } from "../data";

/** A centered line in the chat for a move between accounts or models. */
export function ModelNotice(props: { message: BotMessage }) {
  return (
    <p
      class="model-notice"
      classList={{ "model-notice-warning": props.message.itemType === "modelSwitchExhausted" }}
    >
      <span>{props.message.body}</span>
      <time class="model-notice-time">{props.message.time}</time>
    </p>
  );
}

/**
 * Asks once before a chat's work moves to another provider. Answers the daemon's question with
 * the option labels it sent, so the daemon decides what each answer means.
 */
export function SwitchDialog(props: {
  dialog: ModelSwitchDialog;
  questions: AgentPromptQuestion[];
  onSubmit: (answers: Record<string, string[]>) => Promise<boolean>;
}) {
  const [remember, setRemember] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const labels = (id: string) =>
    props.questions.find((question) => question.id === id)?.options?.map((o) => o.label) ?? [];
  const answer = async (go: boolean) => {
    const choice = labels("choice")[go ? 0 : 1];
    const keep = labels("remember")[go && remember() ? 0 : 1];
    if (!choice || !keep || pending()) return;
    setPending(true);
    try {
      await props.onSubmit({ choice: [choice], remember: [keep] });
    } finally {
      setPending(false);
    }
  };
  const titleId = createUniqueId();
  return (
    <section class="switch-dialog" role="dialog" aria-labelledby={titleId}>
      <h2 id={titleId} class="switch-dialog-title">
        Continue on {props.dialog.provider}?
      </h2>
      <p>
        {props.dialog.from} is at its limit
        {props.dialog.until ? ` until ${props.dialog.until}` : ""}. {props.dialog.to} can continue
        now.
      </p>
      <p class="switch-dialog-detail">
        {props.dialog.provider} will see {props.dialog.project ? "this project's" : "this chat's"}{" "}
        code and the conversation so far.
      </p>
      <label class="switch-dialog-remember">
        <input
          type="checkbox"
          checked={remember()}
          disabled={pending()}
          onChange={(event) => setRemember(event.currentTarget.checked)}
        />
        <span>Don't ask again for {props.dialog.project ?? "this chat"}</span>
      </label>
      <div class="switch-dialog-actions">
        <button
          type="button"
          class="models-button"
          disabled={pending()}
          onClick={() => void answer(false)}
        >
          {props.dialog.until ? `Wait until ${props.dialog.until}` : "Wait"}
        </button>
        <button
          type="button"
          class="models-button models-button-primary"
          disabled={pending()}
          onClick={() => void answer(true)}
        >
          Continue on {props.dialog.provider}
        </button>
      </div>
    </section>
  );
}
