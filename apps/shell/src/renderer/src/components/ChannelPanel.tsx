import { For, Show } from "solid-js";
import type {
  ChannelDetail,
  ChannelRequestActionName,
  ChannelRequestView,
} from "../../../shared/channels";
import { PANEL_ACTIONS, REQUEST_STATE_LABELS } from "../channels";

interface ChannelPanelProps {
  detail: ChannelDetail;
  onOpenChat: (threadId: string) => void;
  onAct: (request: ChannelRequestView, action: ChannelRequestActionName) => void;
}

const ACTION_LABELS: Partial<Record<ChannelRequestActionName, string>> = {
  stop: "Stop",
  resume: "Resume",
  archive: "Archive",
  restore: "Restore",
};

/** Who is in the channel and every request in it, newest first. */
export function ChannelPanel(props: ChannelPanelProps) {
  const requests = () => [...props.detail.requests].reverse();
  return (
    <aside class="channel-panel" aria-label="Channel details">
      <section aria-labelledby="channel-members-title">
        <h2 id="channel-members-title" class="channel-panel-title">
          Members
        </h2>
        <ul class="channel-panel-list">
          <li class="channel-member">
            <span class="channel-member-name">You</span>
            <span class="channel-member-role">Owner</span>
          </li>
          <For each={props.detail.members}>
            {(member) => (
              <li class="channel-member">
                <button
                  type="button"
                  class="channel-member-name channel-link"
                  onClick={() => props.onOpenChat(member.threadId)}
                >
                  {member.name}
                </button>
                <Show when={member.lead}>
                  <span class="channel-lead-badge">Lead</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </section>
      <section aria-labelledby="channel-requests-title">
        <h2 id="channel-requests-title" class="channel-panel-title">
          Requests
        </h2>
        <Show
          when={requests().length > 0}
          fallback={<p class="channel-panel-empty">No requests yet.</p>}
        >
          <ul class="channel-panel-list">
            <For each={requests()}>
              {(request) => (
                <li class="channel-request">
                  <span class="channel-request-title">{request.title}</span>
                  <span class="channel-request-meta">
                    <span class={`task-dot channel-dot-${request.state}`} aria-hidden="true" />
                    {REQUEST_STATE_LABELS[request.state]} · {request.leadName}
                    <Show when={request.tasks.length > 0}>
                      {` · ${request.tasks.length} ${request.tasks.length === 1 ? "task" : "tasks"}`}
                    </Show>
                  </span>
                  <span class="channel-request-actions">
                    <For each={PANEL_ACTIONS[request.state]}>
                      {(action) => (
                        <button
                          type="button"
                          class="channel-text-button"
                          aria-label={`${ACTION_LABELS[action]} ${request.title}`}
                          onClick={() => props.onAct(request, action)}
                        >
                          {ACTION_LABELS[action]}
                        </button>
                      )}
                    </For>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </aside>
  );
}
