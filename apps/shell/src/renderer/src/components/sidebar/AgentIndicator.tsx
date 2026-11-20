import { Show } from "solid-js";

export type SidebarAgentState =
  | { kind: "working" }
  | { kind: "responded" }
  | { kind: "unread"; count: number };

export function sidebarAgentStateLabel(state: SidebarAgentState): string {
  if (state.kind === "working") return "Thinking";
  if (state.kind === "responded") return "Responded";
  return `${state.count} new ${state.count === 1 ? "reply" : "replies"}`;
}

export function SidebarAgentIndicator(props: { state: SidebarAgentState }) {
  const unreadCount = () => (props.state.kind === "unread" ? props.state.count : 0);
  return (
    <span
      class={`bot-row-agent-status bot-row-agent-status-${props.state.kind}`}
      aria-hidden="true"
    >
      <Show when={props.state.kind === "working"}>
        <span class="bot-row-thinking-dots">
          <i />
          <i />
          <i />
        </span>
      </Show>
      <Show when={props.state.kind === "responded"}>
        <svg viewBox="0 0 12 12">
          <title>Responded</title>
          <path d="m3 6.2 1.8 1.8L9 3.8" />
        </svg>
      </Show>
      <Show when={props.state.kind === "unread"}>
        <span>{unreadCount()}</span>
      </Show>
    </span>
  );
}
