import { createUniqueId, For, Show } from "solid-js";
import type { BotMessage, BotProfile } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { ChevronIcon, ThinkingIcon } from "./icons";
import "./status-line.css";

export function AgentActivityIndicator(props: {
  bot: BotProfile | undefined;
  state: "Queued" | "Working" | null;
  /** C9: what the agent is doing, in its words or from its current tool. */
  line?: string | undefined;
}) {
  // "Working" is the fallback, not something the agent said.
  const own = () => (props.line && props.line !== "Working" ? props.line : undefined);
  const text = () => (props.state === "Working" ? (own() ?? "Working") : props.state);
  const name = () => props.bot?.name ?? "Agent";
  const lineId = createUniqueId();
  return (
    <div
      class="agent-activity-entry"
      classList={{ "agent-activity-entry-visible": props.state !== null }}
      role="status"
      aria-hidden={props.state === null}
      // The name stays the same while the line changes, so screen readers aren't told every
      // few seconds; the line is the description, read on request.
      aria-label={props.state ? `${name()} is ${props.state.toLowerCase()}` : undefined}
      aria-describedby={props.state === "Working" && own() ? lineId : undefined}
    >
      <AgentAvatar
        bot={props.bot}
        class={`agent-activity-avatar${props.state === "Working" ? " agent-activity-avatar-breathing" : ""}`}
      />
      <div class="agent-activity-bubble" aria-hidden="true">
        {/* Keyed, so each new line fades in. */}
        <Show when={text()} keyed>
          {(line) => (
            <span id={lineId} class="agent-activity-line">
              {line}
            </span>
          )}
        </Show>
        <span class="agent-activity-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}

export function ThinkingDisclosure(props: { message: BotMessage }) {
  const stepCount = () => props.message.items?.length ?? 0;
  return (
    <article class="thinking-entry">
      <details class="thinking-disclosure">
        <summary aria-label="Show thinking details">
          <span class="thinking-mark" aria-hidden="true">
            <ThinkingIcon />
          </span>
          <span>Thinking</span>
          <Show when={props.message.streaming}>
            <span class="thinking-live-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </Show>
          <Show when={!props.message.streaming && stepCount() > 1}>
            <small>{stepCount()} steps</small>
          </Show>
          <span class="thinking-chevron" aria-hidden="true">
            <ChevronIcon />
          </span>
        </summary>
        <div class="thinking-details">
          <For each={props.message.items ?? []}>{(item) => <p>{item}</p>}</For>
        </div>
      </details>
    </article>
  );
}
