import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { DockAgent, DockState } from "../../../shared/dock";
import type { ConversationMessage } from "../../../shared/ipc";
import { AgentAvatar } from "../components/AgentAvatar";
import { CloseIcon } from "../components/conversation/icons";
import { t } from "../i18n";
import { lastMessage } from "./mini-chat";

const EMPTY: DockState = { position: "right", agents: [], needsYou: 0, expanded: null };

function agentLabel(agent: DockAgent): string {
  if (agent.waiting) return t("dock.agentWaiting", { name: agent.name });
  if (agent.working) return t("dock.agentWorking", { name: agent.name });
  return agent.name;
}

export function Dock() {
  const api = window.openbot.dock;
  const [state, setState] = createSignal<DockState>(EMPTY);
  const [message, setMessage] = createSignal<ConversationMessage | null>(null);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const expanded = () => state().agents.find((agent) => agent.id === state().expanded) ?? null;

  onMount(() => {
    if (!api) return;
    onCleanup(api.onState(setState));
    void api
      .getState()
      .then(setState)
      .catch(() => undefined);
  });

  async function refresh(botId: string) {
    const snapshot = await window.openbot.agent.readConversation(botId).catch(() => null);
    if (snapshot && state().expanded === botId) setMessage(lastMessage(snapshot.messages));
  }

  createEffect(
    on(
      () => state().expanded,
      (botId) => {
        setMessage(null);
        setDraft("");
        if (botId) void refresh(botId);
      },
    ),
  );

  onMount(() => {
    onCleanup(
      window.openbot.agent.onEvent((event) => {
        const botId = state().expanded;
        if (!botId) return;
        if (
          (event.type === "conversation" && event.snapshot.botId === botId) ||
          (event.type === "turn-completed" && event.botId === botId)
        )
          void refresh(botId);
      }),
    );
  });

  function choose(agent: DockAgent) {
    // A second click on the open agent goes to its full chat.
    if (state().expanded === agent.id) void api?.openChat(agent.id);
    else void api?.expand(agent.id);
  }

  async function send(event: SubmitEvent) {
    event.preventDefault();
    const agent = expanded();
    const text = draft().trim();
    if (!agent || !text || sending()) return;
    setSending(true);
    try {
      await window.openbot.agent.sendMessage({ botId: agent.id, text, attachmentDraftIds: [] });
      setDraft("");
    } catch {
      // The draft stays, so the owner can send it again or open the full chat.
    } finally {
      setSending(false);
    }
  }

  return (
    <main
      class="dock"
      onKeyDown={(event) => {
        if (event.key === "Escape" && state().expanded) void api?.expand(null);
      }}
      data-position={state().position}
      data-expanded={state().expanded ? "" : undefined}
    >
      <h1 class="sr-only">{t("dock.label")}</h1>
      <div class="dock-bar">
        <For each={state().agents}>
          {(agent) => (
            <button
              type="button"
              class="dock-agent"
              data-working={agent.working ? "" : undefined}
              data-waiting={agent.waiting ? "" : undefined}
              aria-label={agentLabel(agent)}
              aria-pressed={state().expanded === agent.id}
              title={agent.name}
              onClick={() => choose(agent)}
            >
              <AgentAvatar shape={agent.avatarShape} color={agent.avatarColor} />
            </button>
          )}
        </For>
        <Show when={state().needsYou > 0}>
          <span class="dock-needs-you" role="status">
            <span aria-hidden="true">{state().needsYou}</span>
            <span class="sr-only">{t("dock.needsYou", { count: state().needsYou })}</span>
          </span>
        </Show>
      </div>
      <Show when={expanded()}>
        {(agent) => (
          <section class="dock-chat" aria-label={agent().name}>
            <header class="dock-chat-header">
              <button
                type="button"
                class="dock-chat-name"
                onClick={() => void api?.openChat(agent().id)}
              >
                {agent().name}
              </button>
              <button
                type="button"
                class="dock-chat-close"
                aria-label={t("dock.closeChat")}
                onClick={() => void api?.expand(null)}
              >
                <CloseIcon />
              </button>
            </header>
            <p class="dock-chat-message" aria-live="polite">
              {message()?.text ?? ""}
            </p>
            <form class="dock-chat-composer" onSubmit={(event) => void send(event)}>
              <textarea
                ref={(element) => queueMicrotask(() => element.focus())}
                rows={2}
                value={draft()}
                aria-label={t("dock.message", { name: agent().name })}
                placeholder={t("dock.message", { name: agent().name })}
                onInput={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            </form>
          </section>
        )}
      </Show>
    </main>
  );
}
