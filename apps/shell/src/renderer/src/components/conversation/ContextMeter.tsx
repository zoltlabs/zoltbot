import { createSignal, Show } from "solid-js";
import type { BotProfile } from "../../data";
import { t } from "../../i18n";
import { showToast, Tooltip } from "../../kit";
import { type ContextState, contextAlmostFull, contextPercent } from "./context";
import "./context.css";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A ring in the chat header showing how much of the context window the chat uses. */
export function ContextMeter(props: { context: ContextState }) {
  return (
    <Show when={props.context.usage()}>
      {(usage) => {
        const percent = () => contextPercent(usage());
        return (
          <Tooltip label={t("chat.context.tokens", { used: usage().used, size: usage().size })}>
            <span
              class="context-meter"
              classList={{
                "context-meter-warn": contextAlmostFull(usage()),
                "context-meter-full": percent() >= 95,
              }}
              role="meter"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users focus the meter to read the token count in its tooltip.
              tabIndex={0}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent()}
              aria-label={t("chat.context.meter", { percent: percent() })}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle class="context-meter-track" cx="8" cy="8" r={RADIUS} />
                <circle
                  class="context-meter-fill"
                  cx="8"
                  cy="8"
                  r={RADIUS}
                  stroke-dasharray={`${(percent() / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
                />
              </svg>
            </span>
          </Tooltip>
        );
      }}
    </Show>
  );
}

/**
 * Shown under the header once the context is 80% full: compact the chat, or start a fresh chat
 * with the same agent. The fresh chat doesn't carry this chat's history.
 */
export function ContextBar(props: {
  context: ContextState;
  bot: BotProfile | undefined;
  onSelectAgent: (botId: string) => void;
}) {
  const [busy, setBusy] = createSignal<"compact" | "new" | null>(null);

  async function compact() {
    const id = props.bot?.id;
    setBusy("compact");
    try {
      await props.context.compact();
      if (props.bot?.id === id) showToast({ message: t("chat.context.compacted") });
    } catch {
      if (props.bot?.id === id) showToast({ message: t("chat.context.compactFailed") });
    } finally {
      setBusy(null);
    }
  }

  async function newChat() {
    const bot = props.bot;
    if (!bot) return;
    setBusy("new");
    try {
      const created = await window.openbot.agent.createBot({
        ...(bot.profileId ? { profileId: bot.profileId } : {}),
        ...(bot.projectId ? { projectId: bot.projectId } : {}),
      });
      props.onSelectAgent(created.id);
    } catch {
      showToast({ message: t("chat.context.newChatFailed") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Show when={contextAlmostFull(props.context.usage())}>
      <section class="context-bar" aria-label={t("chat.context.almostFull")}>
        <span class="context-bar-text">{t("chat.context.almostFull")}</span>
        <button
          type="button"
          class="context-bar-button"
          disabled={busy() !== null || props.context.working()}
          onClick={() => void compact()}
        >
          {busy() === "compact" ? t("chat.context.compacting") : t("chat.context.compact")}
        </button>
        <button
          type="button"
          class="context-bar-button"
          disabled={busy() !== null || !props.bot}
          onClick={() => void newChat()}
        >
          {t("chat.context.newChat")}
        </button>
      </section>
    </Show>
  );
}
